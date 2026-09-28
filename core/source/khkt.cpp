#include <aubio/aubio.h>
#include <openssl/crypto.h>
#include <openssl/core_names.h>
#include <openssl/params.h>
#include <openssl/opensslv.h>
#include <openssl/evp.h>
#include <openssl/hmac.h>
#include <openssl/rand.h>

#include <algorithm>
#include <array>
#include <cstdint>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <limits>
#include <memory>
#include <random>
#include <sstream>
#include <string>
#include <vector>

namespace fs = std::filesystem;

namespace {
constexpr size_t kIoBufferSize = 256 * 1024;
constexpr uint64_t kMinFragmentSize = 256 * 1024;
constexpr size_t kMinFragments = 2;
constexpr size_t kMaxFragments = 256;
constexpr size_t kMaxBeatIntervals = 4096;
constexpr size_t kHeaderSize = 24;
constexpr size_t kMacSize = 32;
constexpr size_t kIvSize = 16;
constexpr size_t kAesBlockSize = 16;
constexpr size_t kFixedOverhead = kMacSize + kIvSize;

#pragma pack(push, 1)
struct FileHeader {
    uint32_t index;
    uint32_t total;
    uint64_t sessionId;
    uint64_t payloadSize;
};
#pragma pack(pop)
static_assert(sizeof(FileHeader) == kHeaderSize, "FileHeader format changed");

using CipherCtx = std::unique_ptr<EVP_CIPHER_CTX, decltype(&EVP_CIPHER_CTX_free)>;
using DigestCtx = std::unique_ptr<EVP_MD_CTX, decltype(&EVP_MD_CTX_free)>;
#if OPENSSL_VERSION_NUMBER >= 0x30000000L
class HmacContext {
public:
    HmacContext() : algorithm_(EVP_MAC_fetch(nullptr, "HMAC", nullptr), EVP_MAC_free),
                    context_(algorithm_ ? EVP_MAC_CTX_new(algorithm_.get()) : nullptr, EVP_MAC_CTX_free) {}
    bool initialize(const std::vector<uint8_t>& key) {
        if (!context_) return false;
        char digest[] = "SHA256";
        OSSL_PARAM params[] = {OSSL_PARAM_construct_utf8_string(OSSL_MAC_PARAM_DIGEST, digest, 0), OSSL_PARAM_construct_end()};
        return EVP_MAC_init(context_.get(), key.data(), key.size(), params) == 1;
    }
    bool update(const uint8_t* data, size_t size) { return EVP_MAC_update(context_.get(), data, size) == 1; }
    bool finish(uint8_t* output, size_t capacity, size_t& size) {
        return EVP_MAC_final(context_.get(), output, &size, capacity) == 1;
    }
private:
    std::unique_ptr<EVP_MAC, decltype(&EVP_MAC_free)> algorithm_;
    std::unique_ptr<EVP_MAC_CTX, decltype(&EVP_MAC_CTX_free)> context_;
};
#else
class HmacContext {
public:
    HmacContext() : context_(HMAC_CTX_new(), HMAC_CTX_free) {}
    bool initialize(const std::vector<uint8_t>& key) {
        return context_ && HMAC_Init_ex(context_.get(), key.data(), static_cast<int>(key.size()), EVP_sha256(), nullptr) == 1;
    }
    bool update(const uint8_t* data, size_t size) { return HMAC_Update(context_.get(), data, size) == 1; }
    bool finish(uint8_t* output, size_t capacity, size_t& size) {
        unsigned int resultSize = 0;
        const bool ok = HMAC_Final(context_.get(), output, &resultSize) == 1;
        size = resultSize;
        return ok && size <= capacity;
    }
private:
    std::unique_ptr<HMAC_CTX, decltype(&HMAC_CTX_free)> context_;
};
#endif
using AubioSource = std::unique_ptr<aubio_source_t, decltype(&del_aubio_source)>;
using AubioTempo = std::unique_ptr<aubio_tempo_t, decltype(&del_aubio_tempo)>;
using FVec = std::unique_ptr<fvec_t, decltype(&del_fvec)>;

struct BeatAnalysis {
    std::vector<double> intervals;
    std::string error;
};

struct FragmentMeta {
    fs::path path;
    FileHeader header{};
    std::array<uint8_t, kIvSize> iv{};
    uint64_t ciphertextSize = 0;
};

std::vector<uint8_t> passwordKey(const std::string& password) {
    std::vector<uint8_t> key(EVP_MAX_MD_SIZE);
    unsigned int size = 0;
    EVP_Digest(password.data(), password.size(), key.data(), &size, EVP_sha256(), nullptr);
    key.resize(size);
    return key;
}

bool initSha256(EVP_MD_CTX* ctx) {
    return EVP_DigestInit_ex(ctx, EVP_sha256(), nullptr) == 1;
}

std::string hexDigest(const std::array<uint8_t, 32>& digest) {
    std::ostringstream out;
    out << std::hex << std::setfill('0');
    for (uint8_t byte : digest) out << std::setw(2) << static_cast<unsigned>(byte);
    return out.str();
}

bool finishSha256(EVP_MD_CTX* ctx, std::string& output) {
    std::array<uint8_t, 32> digest{};
    unsigned int size = 0;
    if (EVP_DigestFinal_ex(ctx, digest.data(), &size) != 1 || size != digest.size()) return false;
    output = hexDigest(digest);
    return true;
}

bool randomUint64(uint64_t& value) {
    return RAND_bytes(reinterpret_cast<unsigned char*>(&value), sizeof(value)) == 1;
}

class NameGenerator {
public:
    NameGenerator() : engine_(std::random_device{}()) {}
    std::string next() {
        static constexpr char chars[] = "abcdefghijklmnopqrstuvwxyz0123456789";
        static constexpr char extensions[] = "abcdefghijklmnopqrstuvwxyz";
        std::uniform_int_distribution<int> charDist(0, 35), extDist(0, 25), lenDist(3, 5);
        std::string result(16, ' ');
        for (char& c : result) c = chars[charDist(engine_)];
        result.push_back('.');
        int length = lenDist(engine_);
        for (int i = 0; i < length; ++i) result.push_back(extensions[extDist(engine_)]);
        return result;
    }
private:
    std::mt19937 engine_;
};

BeatAnalysis analyzeBeat(const std::string& audioPath) {
    BeatAnalysis result;
    constexpr uint_t hopSize = 512;
    constexpr uint_t windowSize = 1024;
    AubioSource source(new_aubio_source(audioPath.c_str(), 0, hopSize), del_aubio_source);
    if (!source) {
        result.error = "Khong the mo audio";
        return result;
    }
    const uint_t sampleRate = aubio_source_get_samplerate(source.get());
    const uint_t duration = aubio_source_get_duration(source.get());
    if (sampleRate == 0 || duration == 0) {
        result.error = "Sample rate audio khong hop le";
        return result;
    }
    FVec input(new_fvec(hopSize), del_fvec);
    AubioTempo tempo(new_aubio_tempo("default", windowSize, hopSize, sampleRate), del_aubio_tempo);
    FVec output(new_fvec(2), del_fvec);
    if (!input || !tempo || !output) {
        result.error = "Khong du bo nho de phan tich audio";
        return result;
    }

    double previousBeat = -1.0;
    uint_t samplesRead = 0;
    uint64_t totalSamplesRead = 0;
    do {
        samplesRead = 0;
        aubio_source_do(source.get(), input.get(), &samplesRead);
        if (samplesRead == 0) break;
        totalSamplesRead += samplesRead;
        aubio_tempo_do(tempo.get(), input.get(), output.get());
        if (output->data[0] != 0) {
            const double beat = aubio_tempo_get_last_s(tempo.get());
            if (previousBeat >= 0.0 && beat > previousBeat &&
                result.intervals.size() < kMaxBeatIntervals) {
                result.intervals.push_back(beat - previousBeat);
            }
            previousBeat = beat;
        }
        if (samplesRead < hopSize) break;
    } while (true);

    if (totalSamplesRead < duration) result.error = "Loi khi doc audio";
    return result;
}

std::vector<size_t> createFragmentMap(uint64_t fileSize,
                                      const std::vector<double>& beatIntervals) {
    if (fileSize == 0 || fileSize > std::numeric_limits<size_t>::max()) return {};
    const uint64_t capacityByMinimum = fileSize / kMinFragmentSize;
    size_t count = 1;
    if (capacityByMinimum >= kMinFragments) {
        const size_t audioCount = beatIntervals.size() < kMinFragments
                                      ? kMinFragments : beatIntervals.size();
        count = std::min({audioCount, kMaxFragments,
                          static_cast<size_t>(capacityByMinimum)});
    }
    count = std::max<size_t>(1, count);

    std::vector<double> weights(count, 1.0);
    if (beatIntervals.size() >= 2 && count > 1) {
        std::vector<double> ordered = beatIntervals;
        std::sort(ordered.begin(), ordered.end());
        const double median = ordered[ordered.size() / 2];
        if (median > 0.0) {
            for (size_t i = 0; i < count; ++i) {
                const size_t beatIndex = (i * beatIntervals.size()) / count;
                const double normalized = beatIntervals[std::min(beatIndex, beatIntervals.size() - 1)] / median;
                weights[i] = std::clamp(normalized, 0.5, 2.0);
            }
        }
    }

    uint64_t remaining = fileSize - static_cast<uint64_t>(count) *
                         std::min<uint64_t>(kMinFragmentSize, fileSize / count);
    const uint64_t minimum = std::min<uint64_t>(kMinFragmentSize, fileSize / count);
    long double totalWeight = 0.0L;
    for (double weight : weights) totalWeight += weight;

    std::vector<size_t> sizes(count, static_cast<size_t>(minimum));
    uint64_t allocated = 0;
    for (size_t i = 0; i + 1 < count; ++i) {
        const auto extra = static_cast<uint64_t>(
            static_cast<long double>(remaining) * weights[i] / totalWeight);
        sizes[i] += static_cast<size_t>(extra);
        allocated += extra;
    }
    sizes.back() += static_cast<size_t>(remaining - allocated);
    return sizes;
}

bool writeCiphertext(EVP_CIPHER_CTX* cipher, HmacContext& hmac,
                     std::ofstream& output, const uint8_t* data, size_t size,
                     std::vector<uint8_t>& encrypted) {
    size_t offset = 0;
    while (offset < size) {
        const int chunk = static_cast<int>(std::min(size - offset, kIoBufferSize));
        int produced = 0;
        if (EVP_EncryptUpdate(cipher, encrypted.data(), &produced, data + offset, chunk) != 1) return false;
        if (produced > 0) {
            if (!hmac.update(encrypted.data(), static_cast<size_t>(produced))) return false;
            output.write(reinterpret_cast<const char*>(encrypted.data()), produced);
            if (!output) return false;
        }
        offset += static_cast<size_t>(chunk);
    }
    return true;
}

bool writeEncryptedFragment(const fs::path& path, const FileHeader& header,
                            const std::vector<uint8_t>& key, std::ifstream& input,
                            EVP_MD_CTX* fileDigest, size_t payloadSize,
                            std::vector<uint8_t>& inputBuffer,
                            std::vector<uint8_t>& encryptedBuffer) {
    std::ofstream output(path, std::ios::binary | std::ios::trunc);
    if (!output) return false;
    std::array<uint8_t, kMacSize> emptyMac{};
    std::array<uint8_t, kIvSize> iv{};
    if (RAND_bytes(iv.data(), iv.size()) != 1) return false;
    output.write(reinterpret_cast<const char*>(emptyMac.data()), emptyMac.size());
    output.write(reinterpret_cast<const char*>(iv.data()), iv.size());

    CipherCtx cipher(EVP_CIPHER_CTX_new(), EVP_CIPHER_CTX_free);
    HmacContext hmac;
    if (!cipher || EVP_EncryptInit_ex(cipher.get(), EVP_aes_256_cbc(), nullptr,
                                     key.data(), iv.data()) != 1 ||
        !hmac.initialize(key) || !hmac.update(iv.data(), iv.size())) return false;

    if (!writeCiphertext(cipher.get(), hmac, output,
                         reinterpret_cast<const uint8_t*>(&header), sizeof(header), encryptedBuffer)) return false;

    size_t remaining = payloadSize;
    while (remaining > 0) {
        const size_t amount = std::min(remaining, inputBuffer.size());
        input.read(reinterpret_cast<char*>(inputBuffer.data()), static_cast<std::streamsize>(amount));
        if (input.gcount() != static_cast<std::streamsize>(amount)) return false;
        if (EVP_DigestUpdate(fileDigest, inputBuffer.data(), amount) != 1 ||
            !writeCiphertext(cipher.get(), hmac, output, inputBuffer.data(), amount, encryptedBuffer)) return false;
        remaining -= amount;
    }

    int finalSize = 0;
    if (EVP_EncryptFinal_ex(cipher.get(), encryptedBuffer.data(), &finalSize) != 1) return false;
    if (finalSize > 0) {
        if (!hmac.update(encryptedBuffer.data(), static_cast<size_t>(finalSize))) return false;
        output.write(reinterpret_cast<const char*>(encryptedBuffer.data()), finalSize);
    }
    std::array<uint8_t, kMacSize> mac{};
    size_t macSize = 0;
    if (!output || !hmac.finish(mac.data(), mac.size(), macSize) || macSize != mac.size()) return false;
    output.seekp(0, std::ios::beg);
    output.write(reinterpret_cast<const char*>(mac.data()), mac.size());
    output.flush();
    return output.good();
}

bool inspectFragment(const fs::path& path, const std::vector<uint8_t>& key,
                     FragmentMeta& meta) {
    std::error_code ec;
    const uint64_t fileSize = fs::file_size(path, ec);
    if (ec || fileSize < kFixedOverhead + kAesBlockSize) return false;
    const uint64_t cipherSize = fileSize - kFixedOverhead;
    if (cipherSize % kAesBlockSize != 0) return false;

    std::ifstream input(path, std::ios::binary);
    if (!input) return false;
    std::array<uint8_t, kMacSize> expectedMac{};
    if (!input.read(reinterpret_cast<char*>(expectedMac.data()), expectedMac.size()) ||
        !input.read(reinterpret_cast<char*>(meta.iv.data()), meta.iv.size())) return false;

    HmacContext hmac;
    if (!hmac.initialize(key) || !hmac.update(meta.iv.data(), meta.iv.size())) return false;

    CipherCtx cipher(EVP_CIPHER_CTX_new(), EVP_CIPHER_CTX_free);
    if (!cipher || EVP_DecryptInit_ex(cipher.get(), EVP_aes_256_cbc(), nullptr, key.data(), meta.iv.data()) != 1 ||
        EVP_CIPHER_CTX_set_padding(cipher.get(), 0) != 1) return false;
    std::vector<uint8_t> encrypted(kIoBufferSize), plaintext(kIoBufferSize + EVP_MAX_BLOCK_LENGTH);
    std::array<uint8_t, sizeof(FileHeader)> headerBytes{};
    size_t headerCollected = 0;
    uint64_t remaining = cipherSize;
    bool readHeader = false;
    while (remaining > 0) {
        const size_t amount = static_cast<size_t>(std::min<uint64_t>(remaining, encrypted.size()));
        input.read(reinterpret_cast<char*>(encrypted.data()), static_cast<std::streamsize>(amount));
        if (input.gcount() != static_cast<std::streamsize>(amount) ||
            !hmac.update(encrypted.data(), amount)) return false;
        if (!readHeader) {
            int produced = 0;
            if (EVP_DecryptUpdate(cipher.get(), plaintext.data(), &produced,
                                  encrypted.data(), static_cast<int>(amount)) != 1) return false;
            const size_t copySize = std::min(static_cast<size_t>(produced), headerBytes.size());
            std::copy_n(plaintext.data(), copySize, headerBytes.data());
            headerCollected = copySize;
            readHeader = headerCollected == headerBytes.size();
        }
        remaining -= amount;
    }
    std::array<uint8_t, kMacSize> calculatedMac{};
    size_t macSize = 0;
    if (!hmac.finish(calculatedMac.data(), calculatedMac.size(), macSize) || macSize != calculatedMac.size() ||
        CRYPTO_memcmp(expectedMac.data(), calculatedMac.data(), calculatedMac.size()) != 0 || !readHeader) return false;

    std::memcpy(&meta.header, headerBytes.data(), sizeof(meta.header));
    if (meta.header.total == 0 || meta.header.index >= meta.header.total) return false;
    if (meta.header.payloadSize > std::numeric_limits<uint64_t>::max() - sizeof(FileHeader)) return false;
    const uint64_t plaintextSize = sizeof(FileHeader) + meta.header.payloadSize;
    const uint64_t cipherBlocks = plaintextSize / kAesBlockSize + 1;
    if (cipherBlocks > std::numeric_limits<uint64_t>::max() / kAesBlockSize) return false;
    const uint64_t expectedCipherSize = cipherBlocks * kAesBlockSize;
    if (expectedCipherSize != cipherSize) return false;
    meta.path = path;
    meta.ciphertextSize = cipherSize;
    return true;
}

bool writeDecryptedChunk(const uint8_t* data, size_t size, uint64_t& skipHeader,
                         uint64_t& payloadWritten, uint64_t payloadExpected,
                         EVP_MD_CTX* digest, std::ofstream& output) {
    const size_t skipped = static_cast<size_t>(std::min<uint64_t>(skipHeader, size));
    skipHeader -= skipped;
    data += skipped;
    size -= skipped;
    if (size == 0) return true;
    if (size > payloadExpected - payloadWritten) return false;
    if (EVP_DigestUpdate(digest, data, size) != 1) return false;
    output.write(reinterpret_cast<const char*>(data), static_cast<std::streamsize>(size));
    if (!output) return false;
    payloadWritten += size;
    return true;
}

bool restoreOne(const FragmentMeta& meta, const std::vector<uint8_t>& key,
                EVP_MD_CTX* digest, std::ofstream& output) {
    std::ifstream input(meta.path, std::ios::binary);
    if (!input) return false;
    input.seekg(static_cast<std::streamoff>(kMacSize + kIvSize), std::ios::beg);
    CipherCtx cipher(EVP_CIPHER_CTX_new(), EVP_CIPHER_CTX_free);
    if (!cipher || EVP_DecryptInit_ex(cipher.get(), EVP_aes_256_cbc(), nullptr,
                                      key.data(), meta.iv.data()) != 1) return false;
    std::vector<uint8_t> encrypted(kIoBufferSize), plaintext(kIoBufferSize + EVP_MAX_BLOCK_LENGTH);
    uint64_t remaining = meta.ciphertextSize;
    uint64_t skipHeader = sizeof(FileHeader), payloadWritten = 0;
    while (remaining > 0) {
        const size_t amount = static_cast<size_t>(std::min<uint64_t>(remaining, encrypted.size()));
        input.read(reinterpret_cast<char*>(encrypted.data()), static_cast<std::streamsize>(amount));
        if (input.gcount() != static_cast<std::streamsize>(amount)) return false;
        int produced = 0;
        if (EVP_DecryptUpdate(cipher.get(), plaintext.data(), &produced,
                              encrypted.data(), static_cast<int>(amount)) != 1 ||
            !writeDecryptedChunk(plaintext.data(), static_cast<size_t>(produced), skipHeader,
                                 payloadWritten, meta.header.payloadSize, digest, output)) return false;
        remaining -= amount;
    }
    int produced = 0;
    if (EVP_DecryptFinal_ex(cipher.get(), plaintext.data(), &produced) != 1 ||
        !writeDecryptedChunk(plaintext.data(), static_cast<size_t>(produced), skipHeader,
                             payloadWritten, meta.header.payloadSize, digest, output)) return false;
    return skipHeader == 0 && payloadWritten == meta.header.payloadSize;
}

void error(const std::string& message) {
    std::cerr << "{\"status\":\"error\",\"message\":\"" << message << "\"}\n";
}

bool executeProtectFlow(const std::string& inputPath, const std::string& audioPath,
                        const std::string& outputDir, const std::string& password) {
    std::error_code ec;
    if (!fs::exists(inputPath, ec) || !fs::is_regular_file(inputPath, ec)) {
        error("File input khong ton tai"); return false;
    }
    const uint64_t fileSize = fs::file_size(inputPath, ec);
    if (ec || fileSize == 0 || fileSize > std::numeric_limits<size_t>::max()) {
        error("File input rong, qua lon hoac khong the doc"); return false;
    }
    BeatAnalysis audio = analyzeBeat(audioPath);
    if (!audio.error.empty()) { error(audio.error); return false; }

    if (!fs::exists(outputDir, ec)) {
        fs::create_directories(outputDir, ec);
        if (ec) { error("Khong the tao thu muc output"); return false; }
    }
    if (!fs::is_directory(outputDir, ec) || ec || fs::directory_iterator(outputDir, ec) != fs::directory_iterator()) {
        error("Thu muc output khong rong hoac khong hop le"); return false;
    }
    auto fragmentSizes = createFragmentMap(fileSize, audio.intervals);
    if (fragmentSizes.empty() || fragmentSizes.size() > std::numeric_limits<uint32_t>::max()) {
        error("Khong the tao fragment map"); return false;
    }
    uint64_t sessionId = 0;
    if (!randomUint64(sessionId)) { error("Khong the tao sessionId an toan"); return false; }

    const auto key = passwordKey(password);
    if (key.size() != 32) { error("Khong the tao key SHA-256"); return false; }
    DigestCtx digest(EVP_MD_CTX_new(), EVP_MD_CTX_free);
    if (!digest || !initSha256(digest.get())) { error("Khong the khoi tao SHA-256"); return false; }
    std::ifstream input(inputPath, std::ios::binary);
    if (!input) { error("Khong the mo stream file input"); return false; }
    std::vector<uint8_t> inputBuffer(kIoBufferSize), encryptedBuffer(kIoBufferSize + EVP_MAX_BLOCK_LENGTH);
    NameGenerator names;
    uint64_t totalPayload = 0;
    const uint32_t total = static_cast<uint32_t>(fragmentSizes.size());
    for (uint32_t index = 0; index < total; ++index) {
        const size_t amount = fragmentSizes[index];
        FileHeader header{index, total, sessionId, amount};
        fs::path outPath;
        do { outPath = fs::path(outputDir) / names.next(); }
        while (fs::exists(outPath, ec) && !ec);
        if (ec || !writeEncryptedFragment(outPath, header, key, input, digest.get(),
                                          amount, inputBuffer, encryptedBuffer)) {
            error("Khong the doc hoac ghi fragment"); return false;
        }
        totalPayload += amount;
    }
    char extra;
    if (totalPayload != fileSize || input.read(&extra, 1) || input.bad()) {
        error("Kich thuoc input thay doi trong khi Protect"); return false;
    }
    std::string hash;
    if (!finishSha256(digest.get(), hash)) { error("Khong the hoan tat SHA-256"); return false; }
    std::cout << "{\"status\":\"success\",\"mode\":\"protect\",\"outputDir\":\""
              << outputDir << "\",\"sha256\":\"" << hash << "\",\"fragments\":" << total << "}\n";
    return true;
}

bool executeRestoreFlow(const std::string& inputDir, const std::string& outputFile,
                        const std::string& password) {
    std::error_code ec;
    if (!fs::exists(inputDir, ec) || !fs::is_directory(inputDir, ec)) {
        error("Thu muc .sgt khong ton tai"); return false;
    }
    const auto key = passwordKey(password);
    if (key.size() != 32) { error("Khong the tao key SHA-256"); return false; }
    std::vector<FragmentMeta> fragments;
    for (const auto& entry : fs::directory_iterator(inputDir, ec)) {
        if (ec) { error("Khong the doc thu muc fragment"); return false; }
        if (!entry.is_regular_file(ec)) continue;
        FragmentMeta meta;
        if (!inspectFragment(entry.path(), key, meta)) {
            error("Xac thuc HMAC hoac header that bai. Mat khau sai hoac fragment bi loi/chinh sua"); return false;
        }
        fragments.push_back(std::move(meta));
    }
    if (ec || fragments.empty()) { error("Khong tim thay fragment nao trong thu muc"); return false; }

    const uint32_t total = fragments.front().header.total;
    const uint64_t session = fragments.front().header.sessionId;
    if (fragments.size() != total) {
        error("So luong fragment khong du hoac co fragment du"); return false;
    }
    for (const auto& fragment : fragments) {
        if (fragment.header.total != total || fragment.header.sessionId != session || fragment.header.index >= total) {
            error("Phat hien fragment sai session, total hoac index"); return false;
        }
    }
    std::sort(fragments.begin(), fragments.end(), [](const FragmentMeta& a, const FragmentMeta& b) {
        return a.header.index < b.header.index;
    });
    uint64_t outputSize = 0;
    for (size_t i = 0; i < fragments.size(); ++i) {
        if (fragments[i].header.index != i) { error("Phat hien fragment trung hoac thieu index"); return false; }
        if (fragments[i].header.payloadSize > std::numeric_limits<uint64_t>::max() - outputSize) {
            error("Tong kich thuoc payload bi tran"); return false;
        }
        outputSize += fragments[i].header.payloadSize;
    }

    DigestCtx digest(EVP_MD_CTX_new(), EVP_MD_CTX_free);
    if (!digest || !initSha256(digest.get())) { error("Khong the khoi tao SHA-256"); return false; }
    std::ofstream output(outputFile, std::ios::binary | std::ios::trunc);
    if (!output) { error("Khong the tao file khoi phuc"); return false; }
    for (const auto& fragment : fragments) {
        if (!restoreOne(fragment, key, digest.get(), output)) {
            output.close();
            error("Loi giai ma hoac ghi payload fragment"); return false;
        }
    }
    output.flush();
    if (!output) { error("Loi khi flush file khoi phuc"); return false; }
    output.close();
    std::string hash;
    if (!finishSha256(digest.get(), hash)) { error("Khong the hoan tat SHA-256"); return false; }
    std::cout << "{\"status\":\"success\",\"mode\":\"restore\",\"outputFile\":\""
              << outputFile << "\",\"sha256\":\"" << hash << "\"}\n";
    return true;
}
} // namespace

int main(int argc, char* argv[]) {
    std::ios_base::sync_with_stdio(false);
    std::cin.tie(nullptr);
    if (argc < 2) { error("Thieu che do thuc thi (protect hoac restore)"); return 1; }
    const std::string mode = argv[1];
    std::string password;
    if (mode == "protect") {
        if (argc < 5) { error("Cu phap: ./sentinelgate protect <input> <audio> <output_dir>"); return 1; }
        if (!std::getline(std::cin, password) || password.empty()) { error("Khong nhan duoc password tu STDIN"); return 1; }
        return executeProtectFlow(argv[2], argv[3], argv[4], password) ? 0 : 1;
    }
    if (mode == "restore") {
        if (argc < 4) { error("Cu phap: ./sentinelgate restore <fragment_dir> <output_file>"); return 1; }
        if (!std::getline(std::cin, password) || password.empty()) { error("Khong nhan duoc password tu STDIN"); return 1; }
        return executeRestoreFlow(argv[2], argv[3], password) ? 0 : 1;
    }
    error("Che do khong hop le: " + mode);
    return 1;
}
