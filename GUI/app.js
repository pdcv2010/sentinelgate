const splash = document.getElementById("splash");

const pages = {
    login: document.querySelector(".login-form-view"),
    register: document.getElementById("registerPage"),
    forgot: document.getElementById("forgotPage"),
    otp: document.getElementById("otpPage"),
    newPassword: document.getElementById("newPasswordPage"),
    success: document.getElementById("successPage"),
    home: document.getElementById("homePage")
};

const startTime = Date.now();
const MIN_SPLASH_TIME = 2500;
const appRoot = document.getElementById("app");
let authBootPending = true;
const appNotice = document.getElementById("appNotice");
const appNoticeMessage = document.getElementById("appNoticeMessage");
let appNoticeTimer = null;
let lastServiceState = null;
let lastHealthCheckAt = 0;
let sessionExpired = false;
let dashboardController = null;
let musicSearchTimer = null;

const lowPerformanceDevice = Boolean(
    navigator.connection?.saveData ||
    (navigator.deviceMemory && navigator.deviceMemory <= 4) ||
    (navigator.hardwareConcurrency && navigator.hardwareConcurrency <= 4)
);
if (lowPerformanceDevice) document.documentElement.dataset.performanceMode = "lightweight";

function showAppNotice(message, state = "error", duration = 6500) {
    if (!appNotice || !message) return;
    clearTimeout(appNoticeTimer);
    appNotice.className = `app-notice is-${state}`;
    appNotice.setAttribute("role", state === "error" ? "alert" : "status");
    appNoticeMessage.textContent = message;
    appNoticeTimer = setTimeout(() => appNotice.classList.add("hidden"), duration);
}

function friendlyError(error, context = "") {
    const code = String(error?.code || error?.payload?.error?.code || error?.payload?.code || "").toUpperCase();
    if (context === "login" && error?.status === 401) return "Email hoặc mật khẩu không chính xác.";
    if (error?.sessionReason === "missing") return "Bạn chưa đăng nhập. Hãy đăng nhập để tiếp tục.";
    if (error?.sessionReason === "expired") return "Phiên đăng nhập đã hết hạn hoặc không còn hợp lệ. Hãy đăng nhập lại.";
    if (error?.status === 401) return localStorage.getItem("access_token")
        ? "Phiên đăng nhập đã hết hạn hoặc không còn hợp lệ. Hãy đăng nhập lại."
        : "Bạn chưa đăng nhập. Hãy đăng nhập để tiếp tục.";
    if (["INVALID_PASSWORD", "INVALID_PASSWORD_OR_CORRUPT_FILE"].includes(code)) return "Sai mật khẩu hoặc dữ liệu được bảo vệ bị hỏng. Hãy kiểm tra mật khẩu và thử lại.";
    if (["MISSING_FRAGMENT", "DUPLICATE_FRAGMENT", "HASH_MISMATCH", "INVALID_SESSION"].includes(code)) return "Mảnh dữ liệu bị thiếu hoặc hỏng nên không thể khôi phục tệp.";
    if (["INVALID_FILE", "LIMIT_FILE_SIZE", "LIMIT_FILE_COUNT", "LIMIT_UNEXPECTED_FILE", "INVALID_AUDIO"].includes(code)) return "Tệp không hợp lệ hoặc vượt giới hạn cho phép. Hãy kiểm tra tệp rồi thử lại.";
    if (["NOT_FOUND", "JOB_NOT_FOUND"].includes(code) || error?.status === 404) return "Không tìm thấy tác vụ hoặc tệp này trong tài khoản hiện tại.";
    if (["CORE_UNAVAILABLE", "CORE_TIMEOUT", "CORE_FAILED", "INTERNAL_ERROR"].includes(code)) return "Lõi C++ gặp lỗi khi xử lý. Dữ liệu gốc vẫn chưa được thay đổi; hãy thử lại sau.";
    if (["MUSIC_UNAVAILABLE", "INVALID_QUERY"].includes(code) || context === "music" && error?.status >= 500) {
        return code === "INVALID_QUERY" ? "Nhập từ khóa tìm nhạc từ 2 đến 200 ký tự." : "Dịch vụ tìm nhạc đang gặp lỗi hoặc chưa kết nối được. Hãy thử tìm lại sau.";
    }
    if (code === "JOB_STORE_UNAVAILABLE" || code === "DASHBOARD_UNAVAILABLE") return "Máy chủ chưa tải được dữ liệu. Hãy thử làm mới sau ít phút.";
    if (error?.name === "TypeError" || !error?.status && /fetch|network|kết nối/i.test(error?.message || "")) return "Máy chủ đang ngoại tuyến hoặc không thể kết nối. Hãy kiểm tra dịch vụ rồi thử lại.";
    if (context === "upload" && error?.status >= 400) return "Tải tệp lên thất bại. Hãy kiểm tra tệp và kết nối rồi thử lại.";
    if (context === "music") return "Dịch vụ tìm nhạc hiện không thể tìm bài hát. Hãy thử lại sau.";
    return "Đã xảy ra lỗi. Vui lòng thử lại.";
}

function localizeJobStage(stage, status) {
    const labels = {
        queued: "Đang chờ xử lý", starting: "Đang khởi tạo", processing: "Đang xử lý",
        analyzing: "Đang phân tích", encrypting: "Đang mã hóa", fragmenting: "Đang phân mảnh",
        storing: "Đang lưu trữ", restoring: "Đang khôi phục", completed: "Hoàn thành", failed: "Thất bại"
    };
    const key = String(stage || status || "").toLowerCase();
    return labels[key] || (status === "completed" ? "Hoàn thành" : status === "failed" ? "Thất bại" : "Đang xử lý");
}

function localizeJobMessage(message, status, operation) {
    const value = String(message || "").trim();
    if (value && !/[A-Za-z]{4,}/.test(value)) return value;
    if (status === "completed") return operation === "restore" ? "Tệp đã được khôi phục." : "Tệp đã được bảo vệ.";
    if (status === "failed") return "Không thể hoàn tất tác vụ. Xem thông tin lỗi để biết thêm chi tiết.";
    return "Tác vụ đang được xử lý.";
}

function setFormPending(form, pending, pendingLabel) {
    const submit = form.querySelector("button[type='submit']");
    if (!submit) return;
    if (pending) {
        submit.dataset.idleLabel = submit.textContent;
        submit.textContent = pendingLabel;
        submit.disabled = true;
        form.setAttribute("aria-busy", "true");
    } else {
        submit.textContent = submit.dataset.idleLabel || submit.textContent;
        delete submit.dataset.idleLabel;
        submit.disabled = false;
        form.removeAttribute("aria-busy");
    }
}

function wait(ms) {
    return new Promise(resolve => {
        setTimeout(resolve, ms);
    });
}

function showPage(page) {
    const recoveryPages = ["forgot", "otp", "newPassword", "success"];
    const isRecovery = recoveryPages.includes(page);

    if (page === "home") {
        sgRestoreCustomBackground();
        authStage.classList.add("hidden");
        authStage.classList.remove("register-mode", "recovery-mode");
        Object.values(pages).filter(view => view !== pages.home).forEach(view => view.classList.remove("is-active"));
        document.querySelectorAll(".welcome-copy").forEach(copy => copy.classList.toggle("is-active", copy.classList.contains("welcome-login")));
        resetHomeTab();
        dashboardDock.classList.remove("hidden");
        return;
    }

    sgDeactivateCustomBackground();
    pages.home.classList.add("hidden");
    dashboardDock.classList.add("hidden");
    document.querySelectorAll("[data-home-tab]").forEach(view => {
        view.classList.add("hidden");
        view.classList.remove("is-active", "is-transitioning-out", "is-transitioning-in");
    });
    authStage.classList.remove("hidden");
    authStage.classList.toggle("register-mode", page === "register");
    authStage.classList.toggle("recovery-mode", isRecovery);

    Object.values(pages).forEach(view => view.classList.remove("is-active"));
    pages[page].classList.add("is-active");

    document.querySelectorAll(".welcome-copy").forEach(copy => copy.classList.remove("is-active"));
    const welcomeState = isRecovery ? "recovery" : page;
    document.querySelector(`.welcome-${welcomeState}`).classList.add("is-active");
}

async function checkServer() {
    try {
        const health = await window.SentinelGateApi.health();
        lastHealthCheckAt = Date.now();
        const online = health.status === "online";
        const coreReady = health.engineStatus === "Ready";
        const nextServiceState = !online ? "offline" : coreReady ? "ready" : "core-offline";
        document.documentElement.dataset.apiStatus = online ? "online" : "offline";
        if (nextServiceState === "offline" && lastServiceState !== "offline") showAppNotice("Máy chủ đang ngoại tuyến hoặc không thể kết nối. Hãy kiểm tra dịch vụ rồi thử lại.", "error", 8000);
        else if (nextServiceState === "core-offline" && lastServiceState !== "core-offline") showAppNotice("Lõi C++ chưa sẵn sàng. Các tác vụ bảo vệ/khôi phục có thể thất bại.", "error", 8000);
        else if (lastServiceState === "offline" && online) showAppNotice("Đã kết nối lại với máy chủ.", "success", 3500);
        else if (lastServiceState === "core-offline" && coreReady) showAppNotice("Lõi C++ đã sẵn sàng.", "success", 3500);
        lastServiceState = nextServiceState;
        const status = coreReady ? "Lõi xử lý sẵn sàng" : "Lõi xử lý chưa sẵn sàng";
        const homeStatus = document.getElementById("homeSystemStatus");
        const accountStatus = document.getElementById("accountStatus");
        if (homeStatus) homeStatus.textContent = status;
        if (accountStatus) accountStatus.textContent = status;
        const homeDate = document.getElementById("homeDateValue");
        if (homeDate) homeDate.textContent = new Date().toLocaleDateString("vi-VN", { weekday: "long", day: "numeric", month: "long", year: "numeric" }).toLocaleUpperCase("vi-VN");
        return health.status === "online";
    } catch {
        lastHealthCheckAt = Date.now();
        document.documentElement.dataset.apiStatus = "offline";
        const homeStatus = document.getElementById("homeSystemStatus");
        const accountStatus = document.getElementById("accountStatus");
        if (homeStatus) homeStatus.textContent = "Không kết nối được API";
        if (accountStatus) accountStatus.textContent = "Không kết nối được API";
        if (lastServiceState !== "offline") showAppNotice("Máy chủ đang ngoại tuyến hoặc không thể kết nối. Hãy kiểm tra dịch vụ rồi thử lại.", "error", 8000);
        lastServiceState = "offline";
        return false;
    }
}

async function checkSession() {
    const token = localStorage.getItem("access_token");
    if (!token) {
        window.SentinelGateApi.logout();
        return "unauthenticated";
    }
    try {
        const response = await window.SentinelGateApi.session();
        localStorage.setItem("user", JSON.stringify(response.user));
        return "authenticated";
    } catch (error) {
        if (error.status === 401) {
            window.SentinelGateApi.logout();
            return "unauthenticated";
        }
        // A network/server error cannot establish that the saved session is invalid.
        return "unavailable";
    }
}

async function checkAuthBoot() {
    while (true) {
        try {
            const health = await window.SentinelGateApi.health();
            if (health.status !== "online") throw new Error("Backend health check unavailable");
        } catch {
            await wait(3000);
            continue;
        }

        const session = await checkSession();
        if (session === "authenticated") return true;
        if (session === "unauthenticated") return false;
        await wait(3000);
    }
}

async function startup() {
    const session = await checkAuthBoot();

    const elapsed = Date.now() - startTime;
    const remaining = MIN_SPLASH_TIME - elapsed;

    if (remaining > 0) {
        await wait(remaining);
    }

    if (session) {
        pages.home.dataset.activeSection = pages.home.dataset.activeSection || "Trang chủ";
        showPage("home");
        updateAccountHeader();
        addLogoutButton();
        startDashboardRefresh();
    } else {
        showPage("login");
    }

    // Only expose an auth/home page after the backend has given a definitive result.
    appRoot.classList.remove("hidden");
    authBootPending = false;

    splash.style.transition = "opacity 0.6s ease";
    splash.style.opacity = "0";
    await wait(600);
    splash.style.display = "none";
}

const authStage = document.getElementById("authStage");

const registerButton = document.getElementById("registerButton");
const backLoginButton = document.getElementById("backLoginButton");

registerButton.addEventListener("click", () => {
    showPage("register");
});

backLoginButton.addEventListener("click", () => {
    showPage("login");
});

document.querySelectorAll("[data-back-login]").forEach(button => {
    button.addEventListener("click", () => {
        showPage("login");
    });
});

document.getElementById("forgotButton").addEventListener("click", () => {
    showPage("forgot");
});


document.getElementById("backFromForgot").addEventListener("click", () => {
    showPage("login");
});

document.getElementById("forgotForm").addEventListener("submit", event => {
    event.preventDefault();
    showPage("otp");
});

document.getElementById("resendCode").addEventListener("click", () => {
});

document.getElementById("changeEmail").addEventListener("click", () => {
    showPage("forgot");
});

const otpInputs = document.querySelectorAll(".otp");

otpInputs.forEach((input, index) => {
    input.addEventListener("input", () => {
        input.value = input.value.replace(/\D/g, "");

        if (input.value && index < otpInputs.length - 1) {
            otpInputs[index + 1].focus();
        }

        const complete = [...otpInputs].every(element => {
            return element.value.length === 1;
        });

        if (complete) {
            showPage("newPassword");
        }
    });

    input.addEventListener("keydown", event => {
        if (
            event.key === "Backspace" &&
            !input.value &&
            index > 0
        ) {
            otpInputs[index - 1].focus();
        }
    });
});

document.getElementById("newPasswordForm").addEventListener("submit", event => {
    event.preventDefault();
    const form = event.currentTarget;
    const password = document.getElementById("newPassword").value;
    const confirm = document.getElementById("confirmNewPassword").value;
    if (password !== confirm) {
        showFormError(form, "Mật khẩu xác nhận không khớp.");
        return;
    }
    showPage("success");
});

document.getElementById("successLoginButton").addEventListener("click", () => {
    showPage("login");
});

function showFormError(form, message) {
    let status = form.querySelector("[data-form-status]");
    if (!status) {
        status = document.createElement("p");
        status.dataset.formStatus = "";
        status.className = "form-status is-error";
        status.setAttribute("role", "alert");
        form.insertBefore(status, form.querySelector("button[type='submit']"));
    }
    status.textContent = message;
}

document.querySelectorAll(".auth-form").forEach(form => form.addEventListener("input", () => {
    const status = form.querySelector("[data-form-status]");
    if (status) status.remove();
}));

function updateAccountHeader() {
    let user = {};
    try { user = JSON.parse(localStorage.getItem("user") || "{}"); } catch {}
    const name = user.username || user.email || "Tài khoản";
    const displayName = document.getElementById("accountUsername");
    const avatar = document.querySelector(".account-chip .avatar");
    if (displayName) displayName.textContent = name;
    if (avatar) avatar.textContent = name.split(/[\s@._-]+/).filter(Boolean).slice(0, 2).map(part => part[0]).join("").toUpperCase() || "SG";
    const greeting = document.getElementById("homeGreetingName");
    if (greeting) greeting.textContent = name.split(/[\s@._-]+/)[0] || "bạn";
}

function addLogoutButton() {
    const controls = document.querySelector(".home-header-right");
    if (!controls || document.getElementById("logoutButton")) return;
    const button = document.createElement("button");
    button.id = "logoutButton";
    button.type = "button";
    button.textContent = "Đăng xuất";
    button.style.cssText = "margin-right:12px;padding:9px 13px;border:1px solid rgba(127,234,255,.25);border-radius:12px;background:rgba(11,28,36,.7);color:inherit;cursor:pointer";
    button.addEventListener("click", () => {
        stopDashboardRefresh();
        stopHistoryRefresh(true);
        window.SentinelGateApi.logout();
        resetHomeTab();
        showPage("login");
    });
    controls.insertBefore(button, controls.firstChild);
}

document.getElementById("loginForm").addEventListener("submit", async event => {
    event.preventDefault();
    const form = event.currentTarget;
    setFormPending(form, true, "Đang đăng nhập…");
    try {
        await window.SentinelGateApi.login({
            email: document.getElementById("loginEmail").value.trim(),
            password: document.getElementById("loginPassword").value
        });
        sessionExpired = false;
        resetHomeTab();
        updateAccountHeader();
        showPage("home");
        startDashboardRefresh();
    } catch (error) { showFormError(form, friendlyError(error, "login")); }
    finally { setFormPending(form, false); }
});

document.getElementById("registerForm").addEventListener("submit", async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const password = document.getElementById("registerPassword").value;
    const confirm = document.getElementById("registerConfirm").value;
    if (password !== confirm) {
        showFormError(form, "Mật khẩu xác nhận không khớp.");
        return;
    }
    setFormPending(form, true, "Đang tạo tài khoản…");
    try {
        await window.SentinelGateApi.register({
            username: document.getElementById("registerUsername").value.trim(),
            email: document.getElementById("registerEmail").value.trim(),
            password
        });
        sessionExpired = false;
        resetHomeTab();
        updateAccountHeader();
        showPage("home");
        startDashboardRefresh();
    } catch (error) { showFormError(form, friendlyError(error, "register")); }
    finally { setFormPending(form, false); }
});

let dashboardTimer = null;
let dashboardBusy = false;

function formatDate(value) {
    if (!value) return "Chưa có dữ liệu";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "Chưa có dữ liệu" : date.toLocaleDateString("vi-VN", { day: "numeric", month: "short", year: "numeric" });
}

function formatBytes(bytes) {
    const amount = Number(bytes) || 0;
    if (amount === 0) return "0 B";
    const units = ["B", "KB", "MB", "GB", "TB"];
    const index = Math.min(Math.floor(Math.log(amount) / Math.log(1024)), units.length - 1);
    return `${(amount / (1024 ** index)).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function renderActivity(items) {
    const container = document.getElementById("homeActivityList");
    const count = document.getElementById("homeActivityCount");
    container.replaceChildren();
    count.textContent = `${items.length} hoạt động`;
    document.getElementById("historyFeatureStat").textContent = items.length ? `${items.length} hoạt động gần đây` : "Chưa có hoạt động";
    if (!items.length) {
        const empty = document.createElement("p");
        empty.className = "home-activity-empty";
        empty.textContent = "Chưa có dữ liệu hoạt động.";
        container.append(empty);
        return;
    }
    items.slice(0, 8).forEach(item => {
        const row = document.createElement("div");
        row.className = "home-activity-row";
        const label = document.createElement("strong");
        label.textContent = item.type === "restore" ? "Khôi phục" : "Bảo vệ";
        const name = document.createElement("span");
        name.textContent = item.name || "Tệp";
        const status = document.createElement("small");
        status.textContent = item.status === "completed" ? "Hoàn tất" : item.status === "failed" ? "Lỗi" : item.status === "queued" ? "Đang chờ" : item.status === "processing" ? "Đang xử lý" : "Chưa có dữ liệu";
        const time = document.createElement("time");
        time.textContent = item.createdAt ? new Date(item.createdAt).toLocaleString("vi-VN") : "";
        row.append(label, name, status, time);
        container.append(row);
    });
}

function renderDashboard(payload) {
    const stats = payload.stats || {};
    document.getElementById("statStorage").textContent = formatBytes(stats.storageBytes);
    document.getElementById("statProtectedFiles").textContent = (Number(stats.protectedFiles) || 0).toLocaleString("vi-VN");
    document.getElementById("statProtectedLabel").textContent = `${(Number(stats.totalFragments) || 0).toLocaleString("vi-VN")} mảnh dữ liệu`;
    document.getElementById("statRestoredFiles").textContent = (Number(stats.restoredFiles) || 0).toLocaleString("vi-VN");
    document.getElementById("statActiveJobs").textContent = (Number(stats.activeJobs) || 0).toLocaleString("vi-VN");
    document.getElementById("statJoinedAt").textContent = `Ngày tham gia: ${formatDate(payload.user?.createdAt)}`;
    document.getElementById("summaryJoinDate").textContent = `THÔNG TIN CỦA BẠN · THAM GIA ${formatDate(payload.user?.createdAt).toLocaleUpperCase("vi-VN")}`;
    document.getElementById("vaultFeatureStat").textContent = `${(Number(stats.protectedFiles) || 0).toLocaleString("vi-VN")} tệp đã bảo vệ`;
    document.getElementById("protectionFeatureStat").innerHTML = `<i></i>${(Number(stats.protectedFiles) || 0).toLocaleString("vi-VN")} tệp đã bảo vệ`;
    renderActivity(payload.recentActivity || []);
    const active = Number(stats.activeJobs) > 0;
    if (isDashboardActive()) dashboardTimer = setTimeout(refreshDashboard, active ? 8000 : 30000);
}

function isDashboardActive() {
    return !sessionExpired && !pages.home.classList.contains("hidden") && pages.home.dataset.activeSection === "Trang chủ";
}

async function refreshDashboard() {
    if (!localStorage.getItem("access_token") || !isDashboardActive()) return;
    if (dashboardBusy) {
        dashboardTimer = setTimeout(refreshDashboard, 3000);
        return;
    }
    dashboardBusy = true;
    const controller = new AbortController();
    dashboardController = controller;
    try {
        const payload = await window.SentinelGateApi.dashboardStats({ signal: controller.signal });
        if (!isDashboardActive()) return;
        renderDashboard(payload);
        if (Date.now() - lastHealthCheckAt > 30000) await checkServer();
    } catch (error) {
        if (error.name === "AbortError" || !isDashboardActive()) return;
        if (error.status !== 401) {
            ["statStorage", "statProtectedFiles", "statRestoredFiles", "statActiveJobs"].forEach(id => {
                document.getElementById(id).textContent = "—";
            });
            const activity = document.getElementById("homeActivityList");
            activity.replaceChildren();
            const status = document.createElement("p");
            status.className = "home-activity-empty is-error";
            status.textContent = friendlyError(error, "dashboard");
            activity.append(status);
            showAppNotice(friendlyError(error, "dashboard"), "error", 6000);
            dashboardTimer = setTimeout(refreshDashboard, 15000);
        }
    } finally {
        if (dashboardController === controller) {
            dashboardController = null;
            dashboardBusy = false;
        }
    }
}

function startDashboardRefresh() {
    if (!pages.home.dataset.activeSection) pages.home.dataset.activeSection = "Trang chủ";
    if (!isDashboardActive() || dashboardBusy || dashboardTimer) return;
    refreshDashboard();
}
function stopDashboardRefresh() {
    if (dashboardTimer) clearTimeout(dashboardTimer);
    dashboardTimer = null;
    if (dashboardController) dashboardController.abort();
    dashboardController = null;
    dashboardBusy = false;
}

window.addEventListener("sentinelgate:unauthorized", event => {
    // The boot flow decides between Login and retrying while its session request is pending.
    if (authBootPending) return;
    sessionExpired = true;
    stopDashboardRefresh();
    stopHistoryRefresh(true);
    vaultGeneration += 1;
    vaultBusy = false;
    vaultEntriesCache = [];
    vaultList?.replaceChildren();
    if (vaultCount) vaultCount.textContent = "0 tệp";

    // Clear account-derived values immediately so no previous session data remains visible.
    ["statStorage", "statProtectedFiles", "statRestoredFiles", "statActiveJobs", "statProtectedLabel", "statJoinedAt", "vaultFeatureStat", "protectionFeatureStat"]
        .forEach(id => { const element = document.getElementById(id); if (element) element.textContent = "—"; });
    const activityList = document.getElementById("homeActivityList");
    if (activityList) activityList.replaceChildren();
    const activityCount = document.getElementById("homeActivityCount");
    if (activityCount) activityCount.textContent = "0 hoạt động";
    const username = document.getElementById("accountUsername");
    if (username) username.textContent = "Tài khoản";
    const greeting = document.getElementById("homeGreetingName");
    if (greeting) greeting.textContent = "bạn";
    const accountStatus = document.getElementById("accountStatus");
    if (accountStatus) accountStatus.textContent = "Đăng nhập để tiếp tục";

    // Clear the previous tab immediately so no prior-account workspace reappears after login.
    resetHomeTab();
    const loginForm = document.getElementById("loginForm");
    const reason = event.detail?.reason;
    showFormError(loginForm, reason === "missing"
        ? "Bạn chưa đăng nhập. Hãy đăng nhập để tiếp tục."
        : "Phiên đăng nhập đã hết hạn hoặc không còn hợp lệ. Hãy đăng nhập lại.");
    const modeToggle = document.getElementById("protectionModeToggle");
    if (modeToggle) modeToggle.disabled = false;
    showPage("login");
});

addLogoutButton();
startup();
const homeDockItems = [...document.querySelectorAll(".tool-nav-item")];
const dashboardDock = document.querySelector(".dashboard-dock");
const aboutPage = document.getElementById("aboutPage");
const homeFeatureCards = [...document.querySelectorAll(".feature-card[data-nav-target]")];
const tabViews = [...document.querySelectorAll("[data-home-tab]")];
const historyList = document.getElementById("historyList");
const historyCount = document.getElementById("historyCount");
const historyFilter = document.getElementById("historyFilter");
const historyJobDialog = document.getElementById("historyJobDialog");
const historyDialogBody = document.getElementById("historyDialogBody");
const historyDialogActions = document.getElementById("historyDialogActions");
const historyDialogFeedback = document.getElementById("historyDialogFeedback");
const vaultPage = document.getElementById("vaultPage");
const vaultList = document.getElementById("vaultList");
const vaultCount = document.getElementById("vaultCount");
let vaultEntriesCache = [];
let vaultVisibleLimit = 50;
let vaultGeneration = 0;
let vaultBusy = false;
let historyRefreshTimer = null;
let historyGeneration = 0;
let historyEntriesCache = [];
let historyFilterValue = "all";
let historyVisibleLimit = 50;
let restoreEntriesCache = [];
let restoreVisibleLimit = 50;
const protectionPage = document.getElementById("protectionPage");
const protectionSelection = document.getElementById("protectionSelection");
const protectionProcessing = document.getElementById("protectionProcessing");
const fileInput = document.getElementById("protectFileInput");
const fileDropzone = document.getElementById("fileDropzone");
const selectedFileList = document.getElementById("selectedFileList");
const musicResults = document.getElementById("musicResults");
const musicStatus = document.getElementById("musicSearchStatus");
const musicSearchInput = document.getElementById("musicSearchInput");
const musicSearchForm = document.getElementById("musicSearchForm");
const selectedSongElement = document.getElementById("selectedSong");
const startProtectionButton = document.getElementById("startProtectionButton");
const protectionToast = document.getElementById("protectionToast");

let tabTransitionGeneration = 0;
let selectedFiles = [];
let selectedSong = null;
let protectionMode = "protect";
let selectedRestoreFile = null;
let currentMusicResults = [];
let musicSearchController = null;
let toastTimeout = null;

function getTabView(section) {
    return tabViews.find(view => view.dataset.homeTab === section) || null;
}

function resetHomeTab() {
    tabTransitionGeneration += 1;
    const homeView = getTabView("Trang chủ");
    tabViews.forEach(view => {
        view.classList.remove("is-transitioning-out", "is-transitioning-in");
        view.classList.toggle("is-active", view === homeView);
        view.classList.toggle("hidden", view !== homeView);
    });
    pages.home.dataset.activeSection = "Trang chủ";
    pages.home.classList.remove("hidden");
    aboutPage.classList.add("hidden");
    homeDockItems.forEach(item => {
        const selected = item.dataset.navTarget === "Trang chủ";
        item.classList.toggle("is-current", selected);
        if (selected) item.setAttribute("aria-current", "page");
        else item.removeAttribute("aria-current");
    });
}

async function selectHomeSection(section) {
    const target = getTabView(section);
    if (!target || sessionExpired) return;
    // #homePage is the shared shell that contains every tab, including About.
    pages.home.classList.remove("hidden");
    const active = tabViews.find(view => view.classList.contains("is-active")) || getTabView(pages.home.dataset.activeSection || "Trang chủ");
    pages.home.dataset.activeSection = section;
    homeDockItems.forEach(item => {
        const selected = item.dataset.navTarget === section;
        item.classList.toggle("is-current", selected);
        if (selected) item.setAttribute("aria-current", "page");
        else item.removeAttribute("aria-current");
    });
    if (section === "Trang chủ") {
        if (!dashboardTimer && !dashboardBusy) startDashboardRefresh();
    } else {
        stopDashboardRefresh();
    }
    if (section !== "Lịch sử") stopHistoryRefresh();
    if (section !== "Bảo vệ dữ liệu") {
        musicSearchController?.abort();
        clearTimeout(musicSearchTimer);
    }
    if (active === target) return;

    const generation = ++tabTransitionGeneration;
    if (active) active.classList.add("is-transitioning-out");
    await wait(130);
    if (generation !== tabTransitionGeneration) return;

    tabViews.forEach(view => {
        view.classList.remove("is-active", "is-transitioning-out", "is-transitioning-in");
        view.classList.toggle("hidden", view !== target);
    });
    target.classList.add("is-active", "is-transitioning-in");
    dashboardDock.classList.toggle("hidden", section === "Giới thiệu");
    void target.offsetWidth;
    requestAnimationFrame(() => {
        if (generation === tabTransitionGeneration) target.classList.remove("is-transitioning-in");
    });

    if (section === "Trang chủ") startDashboardRefresh();
    if (section === "Lịch sử") loadHistory();
    if (section === "Kho dữ liệu") loadVault();
}

homeDockItems.forEach(item => item.addEventListener("click", () => selectHomeSection(item.dataset.navTarget)));
homeFeatureCards.forEach(card => card.addEventListener("click", () => {
    const section = card.dataset.navTarget;
    if (getTabView(section)) selectHomeSection(section);
}));

function protectedFilesFromJobs(jobs) {
    return jobs.flatMap(job => {
        if (job.status !== "completed" || !Array.isArray(job.result?.files)) return [];
        return job.result.files.map((file, index) => ({
            jobId: String(job.id),
            fileIndex: Number.isInteger(Number(file.index)) ? Number(file.index) : index,
            name: file.originalName || `Tệp ${index + 1}`,
            sizeBytes: file.sizeBytes ?? null,
            totalFragments: file.totalFragments ?? job.totalFragments ?? null,
            createdAt: job.createdAt || job.completedAt || null,
            completedAt: job.completedAt || null,
            status: job.status
        }));
    }).sort((a, b) => Date.parse(b.completedAt || b.createdAt || 0) - Date.parse(a.completedAt || a.createdAt || 0));
}

function vaultState(kind, title, detail = "") {
    const state = document.createElement("div");
    state.className = `vault-state is-${kind}`;
    state.setAttribute("role", kind === "error" ? "alert" : "status");
    if (kind === "loading") {
        const spinner = document.createElement("span");
        spinner.className = "history-spinner";
        state.append(spinner);
    } else {
        const mark = document.createElement("span");
        mark.className = "vault-state-mark";
        mark.textContent = kind === "success" ? "✓" : kind === "empty" ? "⌁" : "!";
        state.append(mark);
    }
    const heading = document.createElement("strong");
    heading.textContent = title;
    state.append(heading);
    if (detail) {
        const description = document.createElement("small");
        description.textContent = detail;
        state.append(description);
    }
    return state;
}

function renderVaultEntries(entries) {
    vaultList.replaceChildren();
    vaultCount.textContent = `${entries.length.toLocaleString("vi-VN")} ${entries.length === 1 ? "tệp" : "tệp"}`;
    if (!entries.length) {
        vaultList.append(vaultState("empty", "Kho dữ liệu đang trống", "Các tệp sẽ xuất hiện tại đây sau khi tác vụ bảo vệ hoàn tất."));
        return;
    }
    entries.slice(0, vaultVisibleLimit).forEach(entry => {
        const card = document.createElement("article");
        card.className = "vault-file-card";
        card.setAttribute("role", "listitem");
        const icon = document.createElement("span");
        icon.className = "vault-file-icon";
        const extension = entry.name.includes(".") ? entry.name.split(".").pop().slice(0, 4).toUpperCase() : "TỆP";
        icon.textContent = extension;
        const details = document.createElement("div");
        details.className = "vault-file-details";
        const name = document.createElement("strong");
        name.title = entry.name;
        name.textContent = entry.name;
        const metadata = document.createElement("span");
        const timestamp = entry.completedAt || entry.createdAt;
        const dateLabel = timestamp ? new Date(timestamp).toLocaleString("vi-VN", { dateStyle: "medium", timeStyle: "short" }) : "Thời gian không có trong dữ liệu tác vụ";
        const sizeLabel = entry.sizeBytes == null ? "Dung lượng không có trong dữ liệu tác vụ" : formatBytes(entry.sizeBytes);
        const fragmentsLabel = entry.totalFragments == null ? "Số mảnh không có trong dữ liệu tác vụ" : `${Number(entry.totalFragments) || 0} mảnh dữ liệu`;
        metadata.textContent = `${sizeLabel} · ${dateLabel} · ${fragmentsLabel}`;
        details.append(name, metadata);
        const status = document.createElement("span");
        status.className = "vault-file-status";
        status.textContent = "Đã bảo vệ";
        const restore = document.createElement("button");
        restore.type = "button";
        restore.className = "vault-restore-button";
        restore.textContent = "Khôi phục";
        restore.setAttribute("aria-label", `Chọn ${entry.name} để khôi phục`);
        restore.addEventListener("click", () => openVaultFileForRestore(entry));
        card.append(icon, details, status, restore);
        vaultList.append(card);
    });
    if (entries.length > vaultVisibleLimit) {
        const more = document.createElement("button");
        more.type = "button";
        more.className = "history-detail-button vault-load-more";
        more.textContent = `Tải thêm (${(entries.length - vaultVisibleLimit).toLocaleString("vi-VN")})`;
        more.addEventListener("click", () => { vaultVisibleLimit += 50; renderVaultEntries(entries); });
        vaultList.append(more);
    }
}

async function loadVault() {
    if (!vaultPage || vaultBusy || sessionExpired) return;
    const generation = ++vaultGeneration;
    vaultBusy = true;
    vaultCount.textContent = "Đang tải…";
    vaultList.replaceChildren(vaultState("loading", "Đang tải kho dữ liệu…"));
    try {
        const response = await window.SentinelGateApi.protectionJobs();
        if (generation !== vaultGeneration || sessionExpired || pages.home.dataset.activeSection !== "Kho dữ liệu") return;
        vaultEntriesCache = protectedFilesFromJobs(response.jobs || []);
        vaultVisibleLimit = 50;
        renderVaultEntries(vaultEntriesCache);
    } catch (error) {
        if (sessionExpired || generation !== vaultGeneration) return;
        vaultCount.textContent = "Không tải được";
        const state = vaultState("error", friendlyError(error, "vault"), "Thử tải lại danh sách từ tài khoản của bạn.");
        const retry = document.createElement("button");
        retry.type = "button";
        retry.className = "history-refresh";
        retry.textContent = "Thử lại";
        retry.addEventListener("click", loadVault);
        state.append(retry);
        vaultList.replaceChildren(state);
    } finally {
        if (generation === vaultGeneration) vaultBusy = false;
    }
}

async function openVaultFileForRestore(entry) {
    await selectHomeSection("Bảo vệ dữ liệu");
    if (sessionExpired) return;
    await setProtectionMode("restore");
    const restoreIndex = restoreEntriesCache.findIndex(item => item.jobId === entry.jobId && Number(item.fileIndex) === Number(entry.fileIndex));
    if (restoreIndex >= restoreVisibleLimit) {
        restoreVisibleLimit = restoreIndex + 1;
        renderRestoreEntries();
    }
    const item = [...document.querySelectorAll("#restoreJobsList .restore-file-item")].find(row =>
        row.dataset.jobId === entry.jobId && Number(row.dataset.fileIndex) === Number(entry.fileIndex)
    );
    if (item) {
        item.click();
        document.getElementById("restorePassword").focus();
    } else {
        showProtectionError("Không tìm thấy tệp này trong danh sách khôi phục của tài khoản hiện tại.");
    }
}

document.getElementById("refreshVault").addEventListener("click", () => {
    vaultBusy = false;
    loadVault();
});

function historyDate(value) {
    if (!value) return "—";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString("vi-VN", {
        day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit"
    });
}

function historyStatus(status) {
    if (status === "completed") return { label: "Hoàn thành", className: "is-completed" };
    if (status === "failed") return { label: "Thất bại", className: "is-failed" };
    return { label: "Đang xử lý", className: "is-processing" };
}

function historyEntriesFromJobs(protectionJobs, restoreJobs) {
    const entries = [];
    for (const job of protectionJobs) {
        const resultFiles = job.status === "completed" && Array.isArray(job.result?.files) ? job.result.files : [];
        const files = resultFiles.length ? resultFiles : [null];
        for (const file of files) {
            entries.push({
                key: `protect:${job.id}:${file?.index ?? "job"}`,
                operation: "protect", jobId: job.id, fileIndex: file?.index ?? null,
                fileName: file?.originalName || job.currentFile || "Tác vụ bảo vệ",
                createdAt: job.createdAt, completedAt: job.completedAt, status: job.status,
                sizeBytes: file?.sizeBytes ?? null,
                totalFragments: file?.totalFragments ?? job.totalFragments ?? null,
                job
            });
        }
    }
    for (const job of restoreJobs) {
        entries.push({
            key: `restore:${job.id}`, operation: "restore", jobId: job.id, fileIndex: null,
            fileName: job.currentFile || "Tác vụ khôi phục", createdAt: job.createdAt,
            completedAt: job.completedAt, status: job.status, sizeBytes: null,
            totalFragments: job.totalFragments ?? null, job
        });
    }
    return entries.sort((a, b) => Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0));
}

function makeHistoryField(label, value) {
    const item = document.createElement("div");
    item.className = "history-field";
    const caption = document.createElement("span");
    caption.textContent = label;
    const content = document.createElement("strong");
    content.textContent = value;
    item.append(caption, content);
    return item;
}

function renderHistoryList() {
    historyList.replaceChildren();
    const entries = historyFilterValue === "all"
        ? historyEntriesCache
        : historyEntriesCache.filter(entry => entry.operation === historyFilterValue);
    historyCount.textContent = `${entries.length} ${entries.length === 1 ? "hoạt động" : "hoạt động"}`;

    if (!entries.length) {
        const empty = document.createElement("div");
        empty.className = "history-state";
        const mark = document.createElement("span");
        mark.className = "history-state-icon";
        mark.textContent = "⌁";
        const heading = document.createElement("strong");
        heading.textContent = historyEntriesCache.length ? "Không có thao tác phù hợp bộ lọc" : "Chưa có lịch sử hoạt động";
        const hint = document.createElement("small");
        hint.textContent = historyEntriesCache.length ? "Hãy chọn loại thao tác khác." : "Các tác vụ bảo vệ và khôi phục của tài khoản này sẽ xuất hiện tại đây.";
        empty.append(mark, heading, hint);
        historyList.append(empty);
        return;
    }

    for (const entry of entries.slice(0, historyVisibleLimit)) {
        const row = document.createElement("article");
        row.className = "history-row";
        row.setAttribute("role", "listitem");
        const top = document.createElement("div");
        top.className = "history-row-top";
        const file = document.createElement("div");
        file.className = "history-file-name";
        const fileName = document.createElement("strong");
        fileName.textContent = entry.fileName;
        const jobRef = document.createElement("small");
        jobRef.textContent = `Tác vụ ${entry.jobId.slice(0, 12)}`;
        file.append(fileName, jobRef);
        const state = historyStatus(entry.status);
        const status = document.createElement("span");
        status.className = `history-status ${state.className}`;
        status.textContent = state.label;
        top.append(file, status);

        const metadata = document.createElement("div");
        metadata.className = "history-metadata";
        metadata.append(
            makeHistoryField("Thời gian", historyDate(entry.createdAt)),
            makeHistoryField("Loại thao tác", entry.operation === "protect" ? "Bảo vệ" : "Khôi phục"),
            makeHistoryField("Dung lượng", entry.sizeBytes === null ? "—" : formatBytes(entry.sizeBytes)),
            makeHistoryField("Số mảnh dữ liệu", entry.totalFragments === null ? "—" : `${Number(entry.totalFragments) || 0} mảnh dữ liệu`),
            makeHistoryField("Hoàn thành", entry.completedAt ? historyDate(entry.completedAt) : "—")
        );

        const actions = document.createElement("div");
        actions.className = "history-row-actions";
        const detailButton = document.createElement("button");
        detailButton.type = "button";
        detailButton.className = "history-detail-button";
        detailButton.textContent = "Chi tiết";
        detailButton.addEventListener("click", () => openHistoryDetails(entry));
        actions.append(detailButton);
        row.append(top, metadata, actions);
        historyList.append(row);
    }
    if (entries.length > historyVisibleLimit) {
        const more = document.createElement("button");
        more.type = "button";
        more.className = "history-detail-button history-load-more";
        more.textContent = `Tải thêm (${(entries.length - historyVisibleLimit).toLocaleString("vi-VN")})`;
        more.addEventListener("click", () => { historyVisibleLimit += 50; renderHistoryList(); });
        historyList.append(more);
    }
}

function scheduleHistoryRefresh(hasActiveJobs) {
    clearTimeout(historyRefreshTimer);
    historyRefreshTimer = null;
    if (pages.home.dataset.activeSection !== "Lịch sử" || !hasActiveJobs) return;
    historyRefreshTimer = setTimeout(loadHistory, 4000);
}

function stopHistoryRefresh(clearRows = false) {
    clearTimeout(historyRefreshTimer);
    historyRefreshTimer = null;
    historyGeneration += 1;
    if (!clearRows) return;
    historyEntriesCache = [];
    historyList?.replaceChildren();
    if (historyCount) historyCount.textContent = "0 hoạt động";
    if (historyJobDialog?.open) historyJobDialog.close();
    historyDialogBody?.replaceChildren();
    historyDialogActions?.replaceChildren();
    if (historyDialogFeedback) historyDialogFeedback.textContent = "";
}

async function loadHistory() {
    clearTimeout(historyRefreshTimer);
    const generation = ++historyGeneration;
    if (pages.home.dataset.activeSection !== "Lịch sử" || !localStorage.getItem("access_token")) return;
    const loading = document.createElement("div");
    loading.className = "history-state";
    const label = document.createElement("strong");
    label.textContent = "Đang tải lịch sử…";
    loading.append(label);
    historyList.replaceChildren(loading);
    historyCount.textContent = "Đang tải…";
    try {
        const [protectionResponse, restoreResponse] = await Promise.all([
            window.SentinelGateApi.protectionJobs(),
            window.SentinelGateApi.restoreJobs()
        ]);
        if (generation !== historyGeneration || pages.home.dataset.activeSection !== "Lịch sử" || !localStorage.getItem("access_token")) return;
        historyEntriesCache = historyEntriesFromJobs(protectionResponse.jobs || [], restoreResponse.jobs || []);
        renderHistoryList();
        const hasActiveJobs = historyEntriesCache.some(entry => entry.status === "queued" || entry.status === "processing");
        scheduleHistoryRefresh(hasActiveJobs);
    } catch (error) {
        if (generation !== historyGeneration || pages.home.dataset.activeSection !== "Lịch sử") return;
        historyList.replaceChildren();
        const failed = document.createElement("div");
        failed.className = "history-state history-state-error";
        const message = document.createElement("strong");
        message.textContent = friendlyError(error, "history");
        const retry = document.createElement("button");
        retry.type = "button";
        retry.className = "history-detail-button";
        retry.textContent = "Thử lại";
        retry.addEventListener("click", loadHistory);
        failed.append(message, retry);
        historyList.append(failed);
        historyCount.textContent = "Không tải được";
        scheduleHistoryRefresh(false);
    }
}

function openHistoryDetails(entry) {
    const state = historyStatus(entry.status);
    document.getElementById("historyDialogTitle").textContent = entry.fileName;
    historyDialogBody.replaceChildren();
    historyDialogActions.replaceChildren();
    historyDialogFeedback.textContent = "";
    const details = document.createElement("div");
    details.className = "history-detail-grid";
    details.append(
        makeHistoryField("Mã tác vụ", entry.jobId),
        makeHistoryField("Loại thao tác", entry.operation === "protect" ? "Bảo vệ" : "Khôi phục"),
        makeHistoryField("Trạng thái", state.label),
        makeHistoryField("Thời gian", historyDate(entry.createdAt)),
        makeHistoryField("Thời gian hoàn thành", entry.completedAt ? historyDate(entry.completedAt) : "Chưa hoàn thành"),
        makeHistoryField("Dung lượng", entry.sizeBytes === null ? "Không có trong dữ liệu tác vụ" : formatBytes(entry.sizeBytes)),
        makeHistoryField("Số mảnh dữ liệu", entry.totalFragments === null ? "Không có trong dữ liệu tác vụ" : `${Number(entry.totalFragments) || 0} mảnh dữ liệu`),
        makeHistoryField("Tiến trình", `${Math.max(0, Math.min(100, Number(entry.job.progress) || 0))}%`),
        makeHistoryField("Giai đoạn", localizeJobStage(entry.job.stage, entry.status)),
        makeHistoryField("Thông tin", entry.job.error ? friendlyError({ ...entry.job.error, code: entry.job.error.code }, entry.operation) : localizeJobMessage(entry.job.message, entry.status, entry.operation))
    );
    historyDialogBody.append(details);

    if (entry.operation === "protect" && entry.status === "completed" && entry.fileIndex !== null) {
        const restoreButton = document.createElement("button");
        restoreButton.type = "button";
        restoreButton.className = "history-primary-action";
        restoreButton.textContent = "Khôi phục tệp";
        restoreButton.addEventListener("click", () => openRestoreFromHistory(entry));
        historyDialogActions.append(restoreButton);
    }
    if (entry.operation === "restore" && entry.status === "completed") {
        const downloadButton = document.createElement("button");
        downloadButton.type = "button";
        downloadButton.className = "history-primary-action";
        downloadButton.textContent = "Tải tệp đã khôi phục";
        downloadButton.addEventListener("click", () => downloadHistoryRestore(entry));
        historyDialogActions.append(downloadButton);
    }
    if (!historyJobDialog.open) historyJobDialog.showModal();
}

async function openRestoreFromHistory(entry) {
    historyJobDialog.close();
    selectHomeSection("Bảo vệ dữ liệu");
    await setProtectionMode("restore");
    const target = [...restoreJobsList.querySelectorAll(".restore-file-item")].find(item =>
        item.dataset.jobId === entry.jobId && Number(item.dataset.fileIndex) === Number(entry.fileIndex)
    );
    if (target) {
        target.click();
        restorePassword.focus();
    } else {
        showProtectionError("Không tìm thấy tệp này trong danh sách khôi phục của tài khoản.");
    }
}

async function downloadHistoryRestore(entry) {
    historyDialogFeedback.textContent = "Đang tải tệp…";
    try {
        const response = await window.SentinelGateApi.restoreDownload(entry.jobId);
        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = entry.fileName;
        document.body.append(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        historyDialogFeedback.textContent = "Đã tải tệp khôi phục.";
    } catch (error) {
        if (sessionExpired) return;
        historyDialogFeedback.textContent = friendlyError(error, "download");
    }
}

document.getElementById("refreshHistory").addEventListener("click", loadHistory);
document.getElementById("closeHistoryDialog").addEventListener("click", () => historyJobDialog.close());
historyJobDialog.addEventListener("click", event => {
    if (event.target === historyJobDialog) historyJobDialog.close();
});
historyFilter.addEventListener("change", () => {
    historyFilterValue = historyFilter.value;
    historyVisibleLimit = 50;
    renderHistoryList();
});

const protectionModeToggle = document.getElementById("protectionModeToggle");
const protectInputGrid = document.getElementById("protectInputGrid");
const protectFilesPanel = document.getElementById("protectFilesPanel");
const protectActionRow = document.getElementById("protectActionRow");
const restoreWorkflow = document.getElementById("restoreWorkflow");
const restoreJobsList = document.getElementById("restoreJobsList");
const restorePassword = document.getElementById("restorePassword");
const startRestoreButton = document.getElementById("startRestoreButton");

function createRestoreFileItem(entry) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "restore-file-item";
    item.dataset.jobId = entry.jobId;
    item.dataset.fileIndex = String(entry.fileIndex);
    item.setAttribute("role", "option");
    item.setAttribute("aria-selected", "false");
    const icon = document.createElement("span");
    icon.className = "restore-file-icon";
    icon.textContent = "▤";
    const info = document.createElement("span");
    info.className = "restore-file-info";
    const name = document.createElement("strong");
    name.textContent = entry.name;
    const detail = document.createElement("small");
    detail.textContent = `${entry.totalFragments} phân mảnh · ${new Date(entry.createdAt).toLocaleDateString("vi-VN")}`;
    info.append(name, detail);
    const check = document.createElement("span");
    check.className = "restore-file-check";
    check.textContent = "✓";
    item.append(icon, info, check);
    item.addEventListener("click", () => {
        selectedRestoreFile = entry;
        restoreJobsList.querySelectorAll(".restore-file-item").forEach(row => {
            const selected = row === item;
            row.classList.toggle("is-selected", selected);
            row.setAttribute("aria-selected", String(selected));
        });
        document.getElementById("restoreSelectionHint").textContent = `Đã chọn “${entry.name}”. Nhập mật khẩu để giải mã.`;
        updateRestoreReadiness();
    });
    return item;
}

function renderRestoreEntries() {
    restoreJobsList.replaceChildren();
    restoreEntriesCache.slice(0, restoreVisibleLimit).forEach(entry => restoreJobsList.append(createRestoreFileItem(entry)));
    if (restoreEntriesCache.length > restoreVisibleLimit) {
        const more = document.createElement("button");
        more.type = "button";
        more.className = "history-detail-button restore-load-more";
        more.textContent = `Tải thêm (${(restoreEntriesCache.length - restoreVisibleLimit).toLocaleString("vi-VN")})`;
        more.addEventListener("click", () => { restoreVisibleLimit += 50; renderRestoreEntries(); });
        restoreJobsList.append(more);
    }
}

async function renderRestoreFileList() {
    restoreJobsList.replaceChildren();
    selectedRestoreFile = null;
    restoreEntriesCache = [];
    startRestoreButton.classList.add("hidden");
    const loading = document.createElement("div");
    loading.className = "restore-empty-state is-loading";
    loading.setAttribute("role", "status");
    loading.textContent = "Đang tải danh sách từ máy chủ…";
    restoreJobsList.append(loading);
    try {
        const response = await window.SentinelGateApi.protectionJobs();
        const entries = (response.jobs || []).flatMap(job => {
            if (job.status !== "completed" || !Array.isArray(job.result?.files)) return [];
            return job.result.files.map((file, index) => ({
                jobId: job.id,
                fileIndex: Number.isInteger(Number(file.index)) ? Number(file.index) : index,
                name: file.originalName || `Tệp ${index + 1}`,
                totalFragments: Number(file.totalFragments) || Number(job.totalFragments) || 0,
                createdAt: job.completedAt || job.createdAt
            }));
        });
        restoreEntriesCache = entries;
        restoreVisibleLimit = 50;
        restoreJobsList.replaceChildren();
        if (!entries.length) {
            const empty = document.createElement("div");
            empty.className = "restore-empty-state is-empty";
            empty.innerHTML = "<span>⌁</span><strong>Chưa có tệp được bảo vệ</strong><small>Các tệp đã bảo vệ của tài khoản này sẽ xuất hiện tại đây.</small>";
            restoreJobsList.append(empty);
            return;
        }
        renderRestoreEntries();
    } catch (error) {
        if (sessionExpired) return;
        restoreJobsList.replaceChildren();
        const failed = document.createElement("div");
        failed.className = "restore-empty-state is-error";
        const message = document.createElement("strong");
        message.textContent = friendlyError(error, "restore-list");
        const retry = document.createElement("button");
        retry.type = "button";
        retry.className = "restore-refresh";
        retry.textContent = "Thử lại";
        retry.addEventListener("click", renderRestoreFileList);
        failed.append(message, retry);
        restoreJobsList.append(failed);
    }
}
function updateRestoreReadiness() {
    const ready = Boolean(selectedRestoreFile && restorePassword.value);
    startRestoreButton.classList.toggle("hidden", !ready);
}

function setProtectionMode(mode) {
    protectionMode = mode === "restore" ? "restore" : "protect";
    const restoring = protectionMode === "restore";
    protectionPage.dataset.mode = protectionMode;
    protectionModeToggle.dataset.mode = protectionMode;
    protectionModeToggle.setAttribute("aria-label", restoring ? "Chế độ Giải mã" : "Chế độ Bảo vệ");
    protectionModeToggle.setAttribute("aria-pressed", String(restoring));
    document.getElementById("protectionModeLabel").textContent = restoring ? "Giải mã" : "Bảo vệ";
    document.getElementById("protectionModeEyebrow").textContent = restoring ? "GIẢI MÃ / KHÔI PHỤC" : "BẢO VỆ DỮ LIỆU";
    document.getElementById("protectionModeTitle").textContent = restoring ? "Không gian giải mã" : "Không gian bảo vệ";
    document.getElementById("protectionDescription").textContent = restoring
        ? "Chọn tệp đã bảo vệ, nhập mật khẩu và khôi phục tệp gốc."
        : "Kết hợp tệp của bạn với nhịp điệu bài nhạc để tạo cấu trúc phân mảnh riêng.";
    protectInputGrid.classList.toggle("hidden", restoring);
    protectFilesPanel.classList.toggle("hidden", restoring);
    protectActionRow.classList.toggle("hidden", restoring);
    restoreWorkflow.classList.toggle("hidden", !restoring);
    protectionSelection.classList.remove("hidden");
    protectionProcessing.classList.add("hidden");
    if (restoring) return renderRestoreFileList();
    updateProtectionReadiness();
    return Promise.resolve();
}

protectionModeToggle.addEventListener("click", () => {
    setProtectionMode(protectionMode === "protect" ? "restore" : "protect");
});
document.getElementById("refreshRestoreJobs").addEventListener("click", renderRestoreFileList);
restorePassword.addEventListener("input", updateRestoreReadiness);

function showProtectionError(message) {
    protectionToast.textContent = message;
    protectionToast.classList.remove("hidden");
    clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => protectionToast.classList.add("hidden"), 6000);
}

function updateProtectionReadiness() {
    const ready = selectedFiles.length > 0 && selectedSong !== null && Boolean(document.getElementById("protectionPassword")?.value);
    startProtectionButton.classList.toggle("hidden", !ready);
    document.getElementById("protectionHint").classList.toggle("is-ready", ready);
    document.getElementById("protectionHint").textContent = ready
        ? `✦ ${selectedFiles.length} tệp · ${selectedSong.title} đã sẵn sàng cho bước bảo vệ.`
        : "✦ Chọn ít nhất một tệp và một bài nhạc để tiếp tục.";
}

function renderSelectedFiles() {
    selectedFileList.replaceChildren();
    const total = selectedFiles.reduce((sum, file) => sum + file.size, 0);
    document.getElementById("fileCount").textContent = `${selectedFiles.length} ${selectedFiles.length === 1 ? "tệp" : "tệp"}`;
    document.getElementById("totalFileSize").textContent = `${formatBytes(total)} tổng cộng`;
    if (!selectedFiles.length) {
        const empty = document.createElement("div");
        empty.className = "file-list-empty";
        empty.innerHTML = "<span>⌁</span><strong>Danh sách đang trống</strong><small>Thêm tệp ở khung phía trên để bắt đầu.</small>";
        selectedFileList.append(empty);
        updateProtectionReadiness();
        return;
    }
    selectedFiles.forEach((file, index) => {
        const row = document.createElement("div");
        row.className = "selected-file-row";
        row.setAttribute("role", "listitem");
        const extension = file.name.includes(".") ? file.name.split(".").pop().slice(0, 4).toUpperCase() : "TỆP";
        const mark = document.createElement("span");
        mark.className = "file-type-mark";
        mark.textContent = extension;
        const name = document.createElement("span");
        name.className = "selected-file-name";
        const title = document.createElement("strong");
        title.textContent = file.name;
        const size = document.createElement("small");
        size.textContent = `${formatBytes(file.size)} · Sẵn sàng`;
        name.append(title, size);
        const state = document.createElement("span");
        state.className = "file-state";
        state.textContent = "● Đã chọn";
        const remove = document.createElement("button");
        remove.className = "file-remove";
        remove.type = "button";
        remove.setAttribute("aria-label", `Xóa ${file.name} khỏi danh sách`);
        remove.textContent = "×";
        remove.addEventListener("click", () => {
            selectedFiles.splice(index, 1);
            renderSelectedFiles();
        });
        row.append(mark, name, state, remove);
        selectedFileList.append(row);
    });
    updateProtectionReadiness();
}

function addSelectedFiles(fileCollection) {
    const knownFiles = new Set(selectedFiles.map(file => `${file.name}:${file.size}:${file.lastModified ?? file.last_modified ?? 0}`));
    [...fileCollection].forEach(file => {
        const key = `${file.name}:${file.size}:${file.lastModified ?? file.last_modified ?? 0}`;
        if (!knownFiles.has(key)) {
            selectedFiles.push(file);
            knownFiles.add(key);
        }
    });
    renderSelectedFiles();
    fileInput.value = "";
}

const sentinelDesktop = Boolean(window.__TAURI__?.core?.invoke);
fileDropzone.addEventListener("click", async event => {
    if (!sentinelDesktop) return;
    event.preventDefault();
    event.stopPropagation();
    try {
        const result = await window.__TAURI__.dialog.open({ multiple: true, directory: false });
        if (!result) return;
        const paths = Array.isArray(result) ? result : [result];
        const files = await window.__TAURI__.core.invoke("selected_file_info", { paths });
        addSelectedFiles(files);
    } catch (error) {
        showProtectionError(error?.message || "Không thể mở hộp thoại chọn tệp.");
    }
});
fileInput.addEventListener("change", event => addSelectedFiles(event.target.files));
document.getElementById("protectionPassword").addEventListener("input", updateProtectionReadiness);
["dragenter", "dragover"].forEach(type => fileDropzone.addEventListener(type, event => {
    event.preventDefault();
    fileDropzone.classList.add("is-dragover");
}));
["dragleave", "drop"].forEach(type => fileDropzone.addEventListener(type, event => {
    event.preventDefault();
    fileDropzone.classList.remove("is-dragover");
}));
fileDropzone.addEventListener("drop", event => addSelectedFiles(event.dataTransfer.files));

function normalizeSongs(payload) {
    const source = Array.isArray(payload) ? payload : (payload?.songs || payload?.results || payload?.items || payload?.data?.songs || payload?.data?.results || payload?.data?.items || payload?.data || []);
    if (!Array.isArray(source)) return [];
    return source.map((song, index) => ({
        id: String(song.id ?? song.songId ?? song._id ?? `${song.title ?? song.name ?? "track"}-${index}`),
        title: String(song.title ?? song.name ?? song.song_name ?? "Bài nhạc không tên"),
        artist: String(song.artist ?? song.artist_name ?? song.artists?.map?.(artist => typeof artist === "string" ? artist : artist.name).join(", ") ?? song.albumArtist ?? "Nghệ sĩ chưa rõ"),
        duration: song.durationText ?? song.duration ?? "",
        artwork: song.artworkUrl ?? song.coverUrl ?? song.thumbnail ?? song.image ?? song.album?.image ?? ""
    }));
}

function setMusicStatus(message, state = "") {
    musicStatus.textContent = message;
    musicStatus.className = `music-search-status${state ? ` is-${state}` : ""}`;
}

function updateMusicResultsPanel() {
    const panel = musicResults.closest(".music-panel");
    if (!panel) return;

    const hasResults = currentMusicResults.length > 0;
    panel.classList.toggle("has-results", hasResults);
    if (!hasResults) {
        musicResults.style.maxHeight = "";
        panel.style.removeProperty("--music-results-visible-height");
        return;
    }

    musicResults.style.maxHeight = "";
    const styleLimit = Number.parseFloat(getComputedStyle(musicResults).maxHeight) || musicResults.scrollHeight;
    const workspace = musicResults.closest(".protection-workspace");
    const workspaceBottom = workspace?.getBoundingClientRect().bottom || window.innerHeight;
    const availableHeight = Math.max(1, workspaceBottom - musicResults.getBoundingClientRect().top - 12);
    const maxVisibleHeight = Math.min(styleLimit, availableHeight);
    musicResults.style.maxHeight = `${maxVisibleHeight}px`;
    panel.style.setProperty("--music-results-visible-height", `${Math.min(musicResults.scrollHeight, maxVisibleHeight)}px`);
}

window.addEventListener("resize", () => {
    if (currentMusicResults.length) updateMusicResultsPanel();
}, { passive: true });

function renderMusicResults() {
    musicResults.replaceChildren();
    currentMusicResults.forEach(song => {
        const result = document.createElement("button");
        result.type = "button";
        result.className = `music-result${selectedSong?.id === song.id ? " is-selected" : ""}`;
        result.setAttribute("role", "option");
        result.setAttribute("aria-selected", selectedSong?.id === song.id ? "true" : "false");
        const art = document.createElement("span");
        art.className = "song-art";
        if (song.artwork) {
            const image = document.createElement("img");
            image.src = song.artwork;
            image.alt = "";
            image.loading = "lazy";
            art.append(image);
        } else art.textContent = "♫";
        const copy = document.createElement("span");
        copy.className = "song-copy";
        const title = document.createElement("strong"); title.textContent = song.title;
        const artist = document.createElement("small"); artist.textContent = song.artist;
        copy.append(title, artist);
        const duration = document.createElement("span"); duration.className = "song-duration"; duration.textContent = song.duration;
        const selected = document.createElement("span"); selected.className = "song-selected-mark"; selected.textContent = "✓";
        result.append(art, copy, duration, selected);
        result.addEventListener("click", () => {
            selectedSong = song;
            selectedSongElement.replaceChildren();
            const mark = document.createElement("span"); mark.textContent = "♫";
            const label = document.createElement("span"); label.textContent = "Bài nhạc đã chọn:";
            const songName = document.createElement("strong"); songName.textContent = `${song.title} · ${song.artist}`;
            selectedSongElement.append(mark, label, songName);
            selectedSongElement.classList.remove("hidden");
            renderMusicResults();
            setMusicStatus(`Đã chọn “${song.title}”.`, "success");
            updateProtectionReadiness();
        });
        musicResults.append(result);
    });
    updateMusicResultsPanel();
}

async function searchMusic(query) {
    musicSearchController?.abort();
    musicSearchController = new AbortController();
    currentMusicResults = [];
    setMusicStatus("Đang tìm trong thư viện nhạc trên máy chủ...", "loading");
    musicResults.replaceChildren();
    updateMusicResultsPanel();
    const api = window.SentinelGateApi;
    try {
        const payload = await api.searchMusic(query, { signal: musicSearchController.signal });
        currentMusicResults = normalizeSongs(payload);
        renderMusicResults();
        setMusicStatus(currentMusicResults.length ? `${currentMusicResults.length} kết quả từ máy chủ · Chọn một bài nhạc.` : "Không tìm thấy bài nhạc phù hợp.", currentMusicResults.length ? "success" : "empty");
    } catch (error) {
        if (error.name === "AbortError" || sessionExpired) return;
        currentMusicResults = [];
        updateMusicResultsPanel();
        setMusicStatus(friendlyError(error, "music"), "error");
    }
}

musicSearchForm.addEventListener("submit", event => {
    event.preventDefault();
    const query = musicSearchInput.value.trim();
    selectedSong = null;
    selectedSongElement.classList.add("hidden");
    updateProtectionReadiness();
    if (!query) {
        currentMusicResults = [];
        musicResults.replaceChildren();
        updateMusicResultsPanel();
        setMusicStatus("Nhập tên bài hát hoặc nghệ sĩ để tìm kiếm.", "empty");
        return;
    }
    musicSearchController?.abort();
    clearTimeout(musicSearchTimer);
    currentMusicResults = [];
    musicResults.replaceChildren();
    updateMusicResultsPanel();
    musicSearchTimer = setTimeout(() => searchMusic(query), 240);
});

let processingState = {
    stage: "idle", progress: 0, currentFile: "", currentFragment: 0,
    totalFragments: 0, message: ""
};

function renderProcessingState(nextState) {
    processingState = { ...processingState, ...nextState };
    const progress = Math.max(0, Math.min(100, Math.round(processingState.progress || 0)));
    document.getElementById("processingPercent").innerHTML = `${progress}<span>%</span>`;
    document.getElementById("processingTrackFill").style.width = `${progress}%`;
    document.getElementById("processingTrack").setAttribute("aria-valuenow", String(progress));
    document.getElementById("processingKicker").textContent = processingState.operation === "restore" ? "SENTINELGATE · ĐANG GIẢI MÃ" : "SENTINELGATE · ĐANG BẢO VỆ";
    document.getElementById("processingTitle").textContent = processingState.stage === "complete"
        ? (processingState.operation === "restore" ? "Giải mã hoàn tất" : "Bảo vệ hoàn tất")
        : (processingState.operation === "restore" ? "Đang giải mã dữ liệu" : "Đang bảo vệ dữ liệu");
    const progressStatus = processingState.stage === "complete" ? "completed" : processingState.stage === "failed" ? "failed" : "processing";
    document.getElementById("processingMessage").textContent = localizeJobMessage(processingState.message, progressStatus, processingState.operation);
    document.getElementById("processingFileName").textContent = processingState.currentFile || "Đang chuẩn bị tệp";
    document.getElementById("processingFragmentCount").textContent = processingState.totalFragments
        ? `${processingState.currentFragment || processingState.totalFragments} / ${processingState.totalFragments} phân mảnh`
        : "Đang phân tích nhịp";
    const complete = processingState.stage === "complete";
    document.getElementById("processingComplete").classList.toggle("hidden", !complete);
    document.getElementById("processingError").classList.toggle("hidden", processingState.stage !== "failed");
    document.getElementById("processingHomeButton").classList.add("hidden");
    document.getElementById("processingComplete").querySelector("h2").textContent = processingState.operation === "restore" ? "Giải mã hoàn tất" : "Bảo vệ hoàn tất";
    document.getElementById("processingHomeButton").classList.toggle("hidden", !complete);
}

function renderProcessingError(error, context) {
    const message = friendlyError(error, context);
    const code = String(error?.code || error?.payload?.error?.code || "").toUpperCase();
    const title = ["CORE_UNAVAILABLE", "CORE_TIMEOUT", "CORE_FAILED"].includes(code)
        ? "Lõi C++ không thể hoàn tất"
        : ["MISSING_FRAGMENT", "DUPLICATE_FRAGMENT", "HASH_MISMATCH"].includes(code)
            ? "Mảnh dữ liệu bị thiếu hoặc hỏng"
            : ["INVALID_PASSWORD", "INVALID_PASSWORD_OR_CORRUPT_FILE"].includes(code)
                ? "Không thể xác thực mật khẩu"
                : "Không thể hoàn tất thao tác";
    document.getElementById("processingComplete").classList.add("hidden");
    document.getElementById("processingHomeButton").classList.add("hidden");
    document.getElementById("processingErrorTitle").textContent = title;
    document.getElementById("processingErrorMessage").textContent = message;
    document.getElementById("processingError").classList.remove("hidden");
    protectionModeToggle.disabled = false;
    showAppNotice(message, "error", 6000);
}

let currentProtectedJobId = null;
const protectionPassword = document.getElementById("protectionPassword");

async function waitForJob(readJob, onProgress) {
    while (!sessionExpired) {
        if (pages.home.dataset.activeSection !== "Bảo vệ dữ liệu") {
            await wait(500);
            continue;
        }
        const response = await readJob();
        if (sessionExpired) throw new Error("Phiên đăng nhập đã hết hạn.");
        const job = response.job;
        onProgress({
            stage: job.status === "completed" ? "complete" : job.status,
            progress: job.progress || 0,
            currentFile: job.currentFile || "Đang xử lý tệp",
            currentFragment: job.currentFragment || 0,
            totalFragments: job.totalFragments || 0,
            message: job.message || "Đang xử lý..."
        });
        if (job.status === "completed") return job;
        if (job.status === "failed") {
            const failure = new Error(job.error?.message || job.message || "Tiến trình thất bại.");
            failure.code = job.error?.code;
            failure.payload = { error: job.error };
            throw failure;
        }
        await new Promise(resolve => setTimeout(resolve, 1100));
    }
    throw new Error("Phiên đăng nhập đã hết hạn.");
}

async function beginProtection() {
    if (!selectedFiles.length || !selectedSong) return;
    if (!protectionPassword.value) {
        showProtectionError("Hãy nhập mật khẩu để bảo vệ và khôi phục tệp.");
        protectionPassword.focus();
        return;
    }
    protectionSelection.classList.add("hidden");
    protectionProcessing.classList.remove("hidden");
    protectionPage.dataset.mode = "processing";
    protectionToast.classList.add("hidden");
    document.getElementById("processingComplete").classList.add("hidden");
    document.getElementById("processingHomeButton").classList.add("hidden");
    protectionModeToggle.disabled = true;
    renderProcessingState({ operation: "protect", stage: "starting", progress: 0, currentFile: selectedFiles[0].name, currentFragment: 0, totalFragments: 0, message: "Đang gửi yêu cầu bảo vệ..." });
    let audioPath = null;
    let localFragmentDirs = [];
    try {
        if (sentinelDesktop) {
            const api = window.SentinelGateApi;
            const token = localStorage.getItem("access_token");
            audioPath = await window.__TAURI__.core.invoke("download_track_audio", {
                apiBase: api.API_BASE, token, trackId: selectedSong.id
            });
            const localResults = [];
            for (let index = 0; index < selectedFiles.length; index += 1) {
                const file = selectedFiles[index];
                renderProcessingState({ operation: "protect", stage: "processing", progress: Math.floor(index * 30 / selectedFiles.length), currentFile: file.name, message: "Đang mã hóa tệp trên thiết bị…" });
                const result = await window.__TAURI__.core.invoke("protect_local_file", {
                    inputPath: file.path, audioPath, password: protectionPassword.value
                });
                localFragmentDirs.push(...result.fragment_paths);
                localResults.push({
                    originalName: file.name, sizeBytes: file.size,
                    sha256: result.sha256, totalFragments: result.total_fragments,
                    fragmentPaths: result.fragment_paths
                });
            }
            const accepted = await api.createClientProtectionJob(localResults.map(({ fragmentPaths, ...metadata }) => metadata));
            currentProtectedJobId = accepted.jobId;
            const total = localResults.reduce((sum, file) => sum + file.totalFragments, 0);
            let uploaded = 0;
            for (let fileIndex = 0; fileIndex < localResults.length; fileIndex += 1) {
                const file = localResults[fileIndex];
                for (let fragmentIndex = 0; fragmentIndex < file.fragmentPaths.length; fragmentIndex += 1) {
                    await window.__TAURI__.core.invoke("upload_fragment", {
                        apiBase: api.API_BASE, token, jobId: currentProtectedJobId,
                        fileIndex, fragmentIndex, fragmentPath: file.fragmentPaths[fragmentIndex]
                    });
                    uploaded += 1;
                    renderProcessingState({ operation: "protect", stage: "uploading", progress: 30 + Math.floor(65 * uploaded / total), currentFile: file.originalName, currentFragment: uploaded, totalFragments: total, message: "Đang tải các mảnh đã mã hóa lên máy chủ…" });
                }
            }
            await api.completeClientProtectionJob(currentProtectedJobId);
            renderProcessingState({ operation: "protect", stage: "complete", progress: 100, currentFile: selectedFiles.at(-1)?.name, currentFragment: total, totalFragments: total, message: "Tệp đã được mã hóa trên thiết bị và lưu trên máy chủ." });
        } else {
            const accepted = await window.SentinelGateApi.protectFiles([...selectedFiles], selectedSong.id, protectionPassword.value);
            currentProtectedJobId = accepted.jobId;
            await waitForJob(() => window.SentinelGateApi.protectionJob(currentProtectedJobId), state => renderProcessingState(state));
        }
        document.getElementById("processingComplete").querySelector("p").textContent = `Dữ liệu đã được bảo vệ. Mã phiên: ${currentProtectedJobId}`;
        protectionModeToggle.disabled = false;
        await renderRestoreFileList();
    } catch (error) {
        if (sessionExpired) return;
        renderProcessingError(error, "upload");
    } finally {
        if (sentinelDesktop) {
            if (audioPath) window.__TAURI__.core.invoke("remove_temp_path", { path: audioPath }).catch(() => {});
            for (const fragmentPath of localFragmentDirs) window.__TAURI__.core.invoke("remove_temp_path", { path: fragmentPath }).catch(() => {});
        }
    }
}

async function restoreSelectedFile() {
    if (!selectedRestoreFile || !restorePassword.value) return;
    protectionModeToggle.disabled = true;
    protectionSelection.classList.add("hidden");
    protectionProcessing.classList.remove("hidden");
    document.getElementById("processingComplete").classList.add("hidden");
    document.getElementById("processingHomeButton").classList.add("hidden");
    renderProcessingState({ operation: "restore", stage: "starting", progress: 0, currentFile: selectedRestoreFile.name, totalFragments: selectedRestoreFile.totalFragments, message: "Đang tạo yêu cầu giải mã..." });
    let localFragments = null;
    let restoredPath = null;
    try {
        if (sentinelDesktop) {
            const api = window.SentinelGateApi;
            const token = localStorage.getItem("access_token");
            const list = await api.clientJobFragments(selectedRestoreFile.jobId, selectedRestoreFile.fileIndex);
            renderProcessingState({ operation: "restore", stage: "downloading", progress: 10, currentFile: selectedRestoreFile.name, totalFragments: list.fragments.length, message: "Đang tải mảnh mã hóa về thiết bị…" });
            localFragments = await window.__TAURI__.core.invoke("download_fragments", {
                apiBase: api.API_BASE, token, jobId: selectedRestoreFile.jobId,
                fileIndex: selectedRestoreFile.fileIndex, totalFragments: list.fragments.length
            });
            renderProcessingState({ operation: "restore", stage: "processing", progress: 35, currentFile: selectedRestoreFile.name, totalFragments: list.fragments.length, message: "Đang xác thực và khôi phục trên thiết bị…" });
            const restored = await window.__TAURI__.core.invoke("restore_local_fragments", { fragmentDir: localFragments, password: restorePassword.value });
            if (!list.sha256 || restored.sha256.toLowerCase() !== String(list.sha256).toLowerCase()) {
                throw Object.assign(new Error("SHA-256 sau khôi phục không khớp dữ liệu đã bảo vệ."), { code: "HASH_MISMATCH" });
            }
            restoredPath = restored.output_path;
            const destination = await window.__TAURI__.dialog.save({ defaultPath: selectedRestoreFile.name });
            if (!destination) throw new Error("Đã hủy lưu tệp khôi phục.");
            await window.__TAURI__.core.invoke("copy_restored_file", { sourcePath: restoredPath, destinationPath: destination });
            restoredPath = null;
            const history = await api.recordClientRestore({ protectJobId: selectedRestoreFile.jobId, fileIndex: selectedRestoreFile.fileIndex, sha256: restored.sha256 });
            const job = history.job;
            renderProcessingState({ operation: "restore", stage: "complete", progress: 100, currentFile: selectedRestoreFile.name, currentFragment: list.fragments.length, totalFragments: list.fragments.length, message: "Tệp đã được khôi phục và xác minh trên thiết bị." });
            document.getElementById("processingComplete").querySelector("p").textContent = `Đã khôi phục “${selectedRestoreFile.name}” · SHA-256 ${job.result?.sha256 || restored.sha256}`;
        } else {
            const accepted = await window.SentinelGateApi.createRestoreJob({
                jobId: selectedRestoreFile.jobId,
                fileIndex: selectedRestoreFile.fileIndex,
                password: restorePassword.value
            });
            const job = await waitForJob(() => window.SentinelGateApi.restoreJob(accepted.jobId), state => renderProcessingState({ ...state, operation: "restore" }));
            const response = await window.SentinelGateApi.restoreDownload(accepted.jobId);
            const blob = await response.blob();
            const url = URL.createObjectURL(blob);
            const link = document.createElement("a");
            link.href = url;
            link.download = selectedRestoreFile.name;
            document.body.append(link);
            link.click();
            link.remove();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
            document.getElementById("processingComplete").querySelector("p").textContent = `Đã khôi phục “${selectedRestoreFile.name}” · SHA-256 ${job.result?.sha256 || ""}`;
        }
        protectionModeToggle.disabled = false;
    } catch (error) {
        if (sessionExpired) return;
        renderProcessingError(error, "restore");
    } finally {
        if (sentinelDesktop) {
            if (localFragments) window.__TAURI__.core.invoke("remove_temp_path", { path: localFragments }).catch(() => {});
            if (restoredPath) window.__TAURI__.core.invoke("remove_temp_path", { path: restoredPath }).catch(() => {});
        }
    }
}

startProtectionButton.addEventListener("click", beginProtection);
startRestoreButton.addEventListener("click", restoreSelectedFile);
document.getElementById("processingHomeButton").addEventListener("click", () => selectHomeSection("Trang chủ"));
document.getElementById("processingErrorBackButton").addEventListener("click", () => {
    document.getElementById("processingError").classList.add("hidden");
    protectionProcessing.classList.add("hidden");
    protectionSelection.classList.remove("hidden");
    protectionPage.dataset.mode = "selection";
    protectionModeToggle.disabled = false;
});
document.getElementById("dismissAppNotice").addEventListener("click", () => {
    clearTimeout(appNoticeTimer);
    appNotice.classList.add("hidden");
});
renderSelectedFiles();
/* ------------------------------------------------------------------
   Settings & About tabs.
   Reuses the existing health/session/logout flows and cached session data.
   ------------------------------------------------------------------ */
const SENTINELGATE_VERSION = "1.0.0";

const settingsFeedback = document.getElementById("settingsFeedback");
let settingsRequestId = 0;
let settingsFeedbackTimer = null;

function readCachedUser() {
    try { return JSON.parse(localStorage.getItem("user") || "null"); } catch { return null; }
}

function accountInitials(name) {
    const parts = String(name || "").split(/[\s@._-]+/).filter(Boolean).slice(0, 2);
    return parts.map(part => part[0]).join("").toUpperCase() || "SG";
}

function settingsText(id, value) {
    const element = document.getElementById(id);
    if (element) element.textContent = value;
}

function setSettingsServiceRow(rowId, pillId, detailId, state, pill, detail) {
    const row = document.getElementById(rowId);
    if (row) row.dataset.state = state;
    settingsText(pillId, pill);
    settingsText(detailId, detail);
}

function settingsDate(value) {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
}

function settingsAccountJoinLabel(value) {
    const date = settingsDate(value);
    return date
        ? `Ngày tham gia: ${date.toLocaleDateString("vi-VN", { day: "numeric", month: "long", year: "numeric" })}`
        : "Ngày tham gia không có trong dữ liệu phiên";
}

function settingsCheckedLabel() {
    return `Kiểm tra lúc ${new Date().toLocaleTimeString("vi-VN")}`;
}

function settingsTimestampLabel() {
    return new Date().toLocaleString("vi-VN", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function setSettingsFeedback(message, state = "") {
    if (!settingsFeedback) return;
    clearTimeout(settingsFeedbackTimer);
    settingsFeedback.textContent = message || "";
    settingsFeedback.className = `settings-feedback${state ? ` is-${state}` : ""}`;
    if (message) settingsFeedbackTimer = setTimeout(() => {
        settingsFeedback.textContent = "";
        settingsFeedback.className = "settings-feedback";
    }, 6500);
}

function renderSettingsAccount(user) {
    const account = user || {};
    const name = account.username || account.email || "Tài khoản";
    settingsText("settingsAvatar", accountInitials(name));
    settingsText("settingsUsername", name);
    settingsText("settingsEmail", account.email || "Email không có trong dữ liệu phiên");
    settingsText("settingsUserId", account.id ? String(account.id) : "Không có trong dữ liệu phiên");
    settingsText("settingsJoined", settingsAccountJoinLabel(account.createdAt));
    settingsText("settingsAccountScope", account.email ? `Đang đăng nhập: ${account.email}` : "Đang đăng nhập");
}

function resetSettingsStatus() {
    setSettingsServiceRow("settingsBackendRow", "settingsBackendPill", "settingsBackendDetail", "pending", "Đang kiểm tra", "Đang kiểm tra kết nối máy chủ…");
    setSettingsServiceRow("settingsCoreRow", "settingsCorePill", "settingsCoreDetail", "pending", "Đang kiểm tra", "Đang kiểm tra trạng thái lõi C++…");
    settingsText("settingsApiSystem", "—");
    settingsText("settingsCheckedAt", "—");
}

async function refreshSettingsTab() {
    if (sessionExpired || !localStorage.getItem("access_token")) return;
    const requestId = ++settingsRequestId;
    settingsText("settingsServiceChecked", "Đang kiểm tra…");
    settingsText("settingsSessionStatus", "Đang kiểm tra…");
    setSettingsFeedback("");
    resetSettingsStatus();

    let sessionUser = null;
    try {
        const session = await window.SentinelGateApi.session();
        sessionUser = session?.user || null;
        if (sessionUser) localStorage.setItem("user", JSON.stringify(sessionUser));
        if (requestId === settingsRequestId) settingsText("settingsSessionStatus", "Phiên hợp lệ");
    } catch (error) {
        if (requestId !== settingsRequestId) return;
        if (sessionExpired || error?.status === 401) {
            settingsText("settingsSessionStatus", "Phiên không còn hợp lệ");
            return;
        }
        settingsText("settingsSessionStatus", "Không kiểm tra được phiên");
    }
    if (requestId !== settingsRequestId) return;
    renderSettingsAccount(sessionUser || readCachedUser());
    sgRenderSession();

    try {
        const health = await window.SentinelGateApi.health();
        if (requestId !== settingsRequestId) return;
        const online = health?.status === "online";
        const coreReady = health?.engineStatus === "Ready";
        setSettingsServiceRow(
            "settingsBackendRow", "settingsBackendPill", "settingsBackendDetail",
            online ? "ok" : "error",
            online ? "Trực tuyến" : "Ngoại tuyến",
            online ? "Máy chủ đang hoạt động" : "Không nhận được phản hồi từ máy chủ"
        );
        setSettingsServiceRow(
            "settingsCoreRow", "settingsCorePill", "settingsCoreDetail",
            !online ? "error" : coreReady ? "ok" : "warn",
            !online ? "Không xác định" : coreReady ? "Sẵn sàng" : "Chưa sẵn sàng",
            coreReady ? "Lõi xử lý sẵn sàng" : online ? "Lõi xử lý chưa sẵn sàng" : "Cần máy chủ để đọc trạng thái lõi C++"
        );
        settingsText("settingsApiSystem", health?.system || "—");
        settingsText("settingsCheckedAt", settingsTimestampLabel());
        settingsText("settingsServiceChecked", settingsCheckedLabel());
    } catch (error) {
        if (requestId !== settingsRequestId || sessionExpired) return;
        const message = friendlyError(error, "settings");
        setSettingsServiceRow("settingsBackendRow", "settingsBackendPill", "settingsBackendDetail", "error", "Ngoại tuyến", message);
        setSettingsServiceRow("settingsCoreRow", "settingsCorePill", "settingsCoreDetail", "error", "Không xác định", "Cần máy chủ để đọc trạng thái lõi C++");
        settingsText("settingsCheckedAt", settingsTimestampLabel());
        settingsText("settingsServiceChecked", settingsCheckedLabel());
        setSettingsFeedback(message, "error");
    }
}

function initSettingsTab() {
    settingsText("settingsVersion", SENTINELGATE_VERSION);
    const cachedUser = readCachedUser();
    if (cachedUser) renderSettingsAccount(cachedUser);
    sgRenderAppearance();
    sgRenderSession();
    sgRenderStorage();
}

/* Trang Giới thiệu là một terminal Linux có thể "tách" dần. Toàn bộ
   DOM, nội dung và animation nằm trong module
   "ABOUT — INTERACTIVE LINUX TERMINAL" ở cuối file (aboutEnsureInit). */
function initAboutTab() {
    aboutEnsureInit();
}

function logoutFromSettings() {
    const headerLogout = document.getElementById("logoutButton");
    if (headerLogout) {
        // Reuse the existing header logout flow exactly.
        headerLogout.click();
        return;
    }
    stopDashboardRefresh();
    stopHistoryRefresh(true);
    window.SentinelGateApi.logout();
    resetHomeTab();
    showPage("login");
}

document.querySelector('.tool-nav-item[data-nav-target="Cài đặt"]')?.addEventListener("click", () => {
    initSettingsTab();
    refreshSettingsTab();
});
document.querySelector('.tool-nav-item[data-nav-target="Giới thiệu"]')?.addEventListener("click", initAboutTab);
document.querySelector('.feature-card[data-nav-target="Giới thiệu"]')?.addEventListener("click", initAboutTab);
document.getElementById("refreshSettings")?.addEventListener("click", () => {
    initSettingsTab();
    refreshSettingsTab();
});
document.getElementById("settingsLogout")?.addEventListener("click", logoutFromSettings);

window.addEventListener("sentinelgate:unauthorized", () => {
    settingsRequestId += 1;
    settingsText("settingsAvatar", "SG");
    settingsText("settingsUsername", "Tài khoản");
    settingsText("settingsEmail", "—");
    settingsText("settingsUserId", "—");
    settingsText("settingsJoined", "—");
    settingsText("settingsAccountScope", "Chưa đăng nhập");
    settingsText("settingsSessionStatus", "Chưa đăng nhập");
    settingsText("settingsServiceChecked", "Chưa kiểm tra");
    settingsText("settingsSessionToken", "—");
    settingsText("settingsSessionExpiry", "—");
    resetSettingsStatus();
    sgRenderStorage();
    if (settingsFeedback) {
        settingsFeedback.textContent = "";
        settingsFeedback.className = "settings-feedback";
    }
});

/* ------------------------------------------------------------------
   Settings preferences: appearance / effects.
   localStorage only, applied immediately, no dependencies.
   ------------------------------------------------------------------ */
const SG_PREFS_KEY = "sentinelgate.settings.v1";
const SG_SESSION_KEYS = ["access_token", "user"];
const SG_PREF_DEFAULTS = { darkMode: "default", accent: "cyan", fontSize: "medium", effects: "full" };
const SG_ACCENT_IDS = ["cyan", "magenta", "lime", "amber"];
const SG_FONT_IDS = ["small", "medium", "large"];
const SG_FONT_SCALES = { small: 0.9, medium: 1, large: 1.15 };

function sgSanitizePrefs(raw) {
    const prefs = { ...SG_PREF_DEFAULTS };
    if (!raw || typeof raw !== "object") return prefs;
    if (raw.darkMode === "oled" || raw.darkMode === "default") prefs.darkMode = raw.darkMode;
    if (SG_ACCENT_IDS.includes(raw.accent)) prefs.accent = raw.accent;
    if (SG_FONT_IDS.includes(raw.fontSize)) prefs.fontSize = raw.fontSize;
    if (raw.effects === "reduced" || raw.effects === "full") prefs.effects = raw.effects;
    return prefs;
}

function sgReadPrefs() {
    let raw = null;
    try { raw = JSON.parse(localStorage.getItem(SG_PREFS_KEY) || "null"); } catch { raw = null; }
    const prefs = sgSanitizePrefs(raw);
    if (raw && typeof raw === "object" && Object.prototype.hasOwnProperty.call(raw, "sound")) {
        try { localStorage.setItem(SG_PREFS_KEY, JSON.stringify(prefs)); } catch {}
    }
    return prefs;
}

let sgPrefs = sgReadPrefs();

function sgPersistPrefs() {
    try { localStorage.setItem(SG_PREFS_KEY, JSON.stringify(sgPrefs)); } catch {}
}

function sgApplyPrefs() {
    const root = document.documentElement;
    root.dataset.sgDark = sgPrefs.darkMode === "oled" ? "oled" : "default";
    root.dataset.sgAccent = SG_ACCENT_IDS.includes(sgPrefs.accent) ? sgPrefs.accent : "cyan";
    root.dataset.sgFont = SG_FONT_IDS.includes(sgPrefs.fontSize) ? sgPrefs.fontSize : "medium";
    root.dataset.sgEffects = sgPrefs.effects === "reduced" ? "reduced" : "full";
    root.style.setProperty("--sg-font-scale", String(SG_FONT_SCALES[sgPrefs.fontSize] || 1));
}

const settingsFeedbackTimers = {};

function settingsFeedbackFor(targetId, message, state = "") {
    const element = document.getElementById(targetId);
    if (!element) return;
    clearTimeout(settingsFeedbackTimers[targetId]);
    element.textContent = message || "";
    element.className = `settings-feedback${state ? ` is-${state}` : ""}`;
    if (message) settingsFeedbackTimers[targetId] = setTimeout(() => {
        element.textContent = "";
        element.className = "settings-feedback";
    }, 6000);
}

function sgSetSwitch(elementId, checked, label) {
    const button = document.getElementById(elementId);
    if (!button) return;
    button.setAttribute("aria-checked", String(checked));
    const text = button.querySelector(".settings-switch-label");
    if (text) text.textContent = label;
}

function sgRenderAppearance() {
    sgSetSwitch("settingDarkMode", sgPrefs.darkMode === "oled", sgPrefs.darkMode === "oled" ? "Đen sâu" : "Mặc định");
    sgSetSwitch("settingEffects", sgPrefs.effects === "reduced", sgPrefs.effects === "reduced" ? "Giảm" : "Đầy đủ");
    document.querySelectorAll('.settings-choices[data-setting="accent"] button').forEach(button => {
        const selected = button.dataset.value === sgPrefs.accent;
        button.classList.toggle("is-selected", selected);
        button.setAttribute("aria-checked", String(selected));
    });
    document.querySelectorAll('.settings-choices[data-setting="fontSize"] button').forEach(button => {
        const selected = button.dataset.value === sgPrefs.fontSize;
        button.classList.toggle("is-selected", selected);
        button.setAttribute("aria-checked", String(selected));
    });
    const summary = document.getElementById("settingsAppearanceSummary");
    if (summary) {
        const dark = sgPrefs.darkMode === "oled" ? "Đen sâu" : "Tối mặc định";
        const font = { small: "Nhỏ", medium: "Vừa", large: "Lớn" }[sgPrefs.fontSize] || "Vừa";
        summary.textContent = `${dark} · ${sgPrefs.accent.toUpperCase()} · ${font}`;
    }
}

const SG_BACKGROUND_DB_NAME = "sentinelgate-user-backgrounds";
const SG_BACKGROUND_STORE = "backgrounds";
let sgBackgroundDbPromise = null;
let sgBackgroundObjectUrl = null;
let sgBackgroundLoadGeneration = 0;

function sgCurrentUserScope() {
    try {
        const user = JSON.parse(localStorage.getItem("user") || "null");
        if (user?.id !== undefined && user?.id !== null && String(user.id).trim()) return `id:${String(user.id)}`;
        if (user?.email) return `email:${String(user.email).trim().toLowerCase()}`;
    } catch {}
    return "";
}

function sgOpenBackgroundDb() {
    if (!window.indexedDB) return Promise.reject(new Error("IndexedDB không khả dụng."));
    if (sgBackgroundDbPromise) return sgBackgroundDbPromise;
    sgBackgroundDbPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(SG_BACKGROUND_DB_NAME, 1);
        request.onupgradeneeded = () => {
            if (!request.result.objectStoreNames.contains(SG_BACKGROUND_STORE)) {
                request.result.createObjectStore(SG_BACKGROUND_STORE);
            }
        };
        request.onsuccess = () => {
            const db = request.result;
            db.onversionchange = () => { db.close(); sgBackgroundDbPromise = null; };
            resolve(db);
        };
        request.onerror = () => reject(request.error || new Error("Không mở được kho nền cục bộ."));
        request.onblocked = () => reject(new Error("Kho nền đang được sử dụng ở cửa sổ khác."));
    }).catch(error => { sgBackgroundDbPromise = null; throw error; });
    return sgBackgroundDbPromise;
}

async function sgBackgroundDbAction(action, key, value) {
    const db = await sgOpenBackgroundDb();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(SG_BACKGROUND_STORE, action === "get" ? "readonly" : "readwrite");
        const store = transaction.objectStore(SG_BACKGROUND_STORE);
        const request = action === "get" ? store.get(key)
            : action === "delete" ? store.delete(key)
                : store.put(value, key);
        let result;
        request.onsuccess = () => { result = request.result; };
        request.onerror = () => reject(request.error || new Error("Không đọc/ghi được nền tùy chỉnh."));
        transaction.oncomplete = () => resolve(result);
        transaction.onerror = () => reject(transaction.error || new Error("Không hoàn tất thao tác nền."));
        transaction.onabort = () => reject(transaction.error || new Error("Thao tác nền đã bị hủy."));
    });
}

function sgClearCustomBackgroundView() {
    const root = document.getElementById("appCustomBackground");
    const image = document.getElementById("appCustomBackgroundImage");
    const video = document.getElementById("appCustomBackgroundVideo");
    const overlay = document.getElementById("appCustomBackgroundOverlay");
    if (video) {
        video.pause();
        video.removeAttribute("src");
        video.load();
        video.classList.add("hidden");
    }
    if (image) {
        image.removeAttribute("src");
        image.classList.add("hidden");
    }
    root?.classList.add("hidden");
    overlay?.classList.add("hidden");
    document.documentElement.removeAttribute("data-custom-background");
    if (sgBackgroundObjectUrl) URL.revokeObjectURL(sgBackgroundObjectUrl);
    sgBackgroundObjectUrl = null;
}

function sgDeactivateCustomBackground() {
    sgBackgroundLoadGeneration += 1;
    sgClearCustomBackgroundView();
}

function sgApplyCustomBackground(record) {
    if (!record?.blob || !(record.blob instanceof Blob)) return false;
    const root = document.getElementById("appCustomBackground");
    const image = document.getElementById("appCustomBackgroundImage");
    const video = document.getElementById("appCustomBackgroundVideo");
    const overlay = document.getElementById("appCustomBackgroundOverlay");
    if (!root || !image || !video || !overlay) return false;
    sgClearCustomBackgroundView();
    sgBackgroundObjectUrl = URL.createObjectURL(record.blob);
    root.classList.remove("hidden");
    overlay.classList.remove("hidden");
    document.documentElement.dataset.customBackground = "true";
    if (record.kind === "video") {
        video.src = sgBackgroundObjectUrl;
        video.muted = true;
        video.loop = true;
        video.autoplay = true;
        video.playsInline = true;
        video.controls = false;
        video.classList.remove("hidden");
        const playAttempt = video.play();
        if (playAttempt?.catch) playAttempt.catch(() => {});
    } else {
        image.src = sgBackgroundObjectUrl;
        image.classList.remove("hidden");
    }
    return true;
}

async function sgRestoreCustomBackground() {
    const generation = ++sgBackgroundLoadGeneration;
    const scope = sgCurrentUserScope();
    sgClearCustomBackgroundView();
    if (!scope) return;
    try {
        const record = await sgBackgroundDbAction("get", scope);
        if (generation !== sgBackgroundLoadGeneration || scope !== sgCurrentUserScope()) return;
        if (record) sgApplyCustomBackground(record);
    } catch {
        if (generation === sgBackgroundLoadGeneration) {
            settingsFeedbackFor("settingsAppearanceFeedback", "Không thể đọc nền đã lưu trên thiết bị này.", "error");
        }
    }
}

function sgValidBackgroundFile(file, kind) {
    const name = String(file?.name || "").toLowerCase();
    if (kind === "image") return /^image\/(png|jpeg|webp|gif)$/.test(file.type || "") || (!file.type && /\.(png|jpe?g|webp|gif)$/.test(name));
    return /^video\/(mp4|webm|ogg)$/.test(file.type || "") || (!file.type && /\.(mp4|webm|ogv|ogg)$/.test(name));
}

async function sgSaveSelectedBackground(file, kind) {
    if (!file || !sgValidBackgroundFile(file, kind)) {
        settingsFeedbackFor("settingsAppearanceFeedback", kind === "image"
            ? "Định dạng ảnh không hợp lệ. Hãy chọn PNG, JPG, WEBP hoặc GIF."
            : "Định dạng video không hợp lệ. Hãy chọn MP4, WebM hoặc OGG.", "error");
        return;
    }
    const scope = sgCurrentUserScope();
    if (!scope) {
        settingsFeedbackFor("settingsAppearanceFeedback", "Hãy đăng nhập để lưu nền riêng cho tài khoản này.", "error");
        return;
    }
    const record = { blob: file, kind, name: file.name || "background", updatedAt: Date.now() };
    try {
        await sgBackgroundDbAction("put", scope, record);
        if (scope !== sgCurrentUserScope()) return;
        sgBackgroundLoadGeneration += 1;
        sgApplyCustomBackground(record);
        settingsFeedbackFor("settingsAppearanceFeedback", kind === "image" ? "Đã áp dụng và lưu ảnh nền cho tài khoản này." : "Đã áp dụng và lưu video nền cho tài khoản này.", "success");
    } catch {
        if (scope === sgCurrentUserScope()) {
            sgBackgroundLoadGeneration += 1;
            sgApplyCustomBackground(record);
            settingsFeedbackFor("settingsAppearanceFeedback", "Đã áp dụng nền đến khi đóng phiên, nhưng trình duyệt không lưu được vào IndexedDB.", "error");
        }
    }
}

async function sgRemoveCustomBackground() {
    const scope = sgCurrentUserScope();
    sgBackgroundLoadGeneration += 1;
    sgClearCustomBackgroundView();
    if (scope) {
        try { await sgBackgroundDbAction("delete", scope); }
        catch {
            settingsFeedbackFor("settingsAppearanceFeedback", "Đã gỡ nền khỏi giao diện nhưng không xóa được bản lưu trên thiết bị.", "error");
            return;
        }
    }
    settingsFeedbackFor("settingsAppearanceFeedback", "Đã xóa nền tùy chỉnh và khôi phục nền SentinelGate.", "success");
}

function sgDecodeToken(token) {
    try {
        const segments = String(token).split(".");
        if (segments.length < 2) return null;
        const base64 = segments[1].replace(/-/g, "+").replace(/_/g, "/");
        const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
        const binary = atob(padded);
        const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
        return JSON.parse(new TextDecoder().decode(bytes));
    } catch { return null; }
}

function sgRemainingLabel(target) {
    const diff = target.getTime() - Date.now();
    if (diff <= 0) return "đã hết hạn";
    const minutes = Math.round(diff / 60000);
    return minutes < 60 ? `${minutes} phút` : `${Math.round(minutes / 60)} giờ`;
}

function sgRenderSession() {
    const token = localStorage.getItem("access_token");
    const claims = token ? sgDecodeToken(token) : null;
    const expiry = claims && claims.exp ? new Date(claims.exp * 1000) : null;
    settingsText("settingsSessionToken", token ? `JWT · ${token.length} ký tự` : "Không có token trên thiết bị");
    settingsText("settingsSessionExpiry", expiry && !Number.isNaN(expiry.getTime())
        ? `${expiry.toLocaleString("vi-VN")} · còn ${sgRemainingLabel(expiry)}`
        : "Không đọc được từ token hiện tại");
}

function sgStorageReport() {
    const report = { total: 0, bytes: 0, temporary: [] };
    try {
        for (let index = 0; index < localStorage.length; index += 1) {
            const key = localStorage.key(index);
            if (key === null) continue;
            const value = localStorage.getItem(key) || "";
            report.total += 1;
            report.bytes += key.length + value.length;
            if (!SG_SESSION_KEYS.includes(key) && key !== SG_PREFS_KEY) report.temporary.push(key);
        }
    } catch {}
    return report;
}

function sgSetPreference(key, value) {
    if (sgPrefs[key] === value) return false;
    sgPrefs[key] = value;
    sgPersistPrefs();
    sgApplyPrefs();
    sgRenderAppearance();
    return true;
}

function sgRenderStorage() {
    const report = sgStorageReport();
    settingsText("settingsStorageUsage", formatBytes(report.bytes));
    settingsText("settingsStorageCount", `${report.total} khóa · ${report.temporary.length} dữ liệu tạm`);
    const fill = document.getElementById("settingsStorageFill");
    if (fill) fill.style.width = `${Math.min(100, Math.max(4, (report.bytes / 51200) * 100)).toFixed(1)}%`;
    const clearButton = document.getElementById("clearSettingsData");
    if (clearButton) clearButton.disabled = report.temporary.length === 0;
}

let sgClearTimer = null;

function sgResetClearAction(button) {
    if (!button) return;
    button.dataset.pending = "false";
    if (button.dataset.idleLabel) {
        button.textContent = button.dataset.idleLabel;
        delete button.dataset.idleLabel;
    }
}

function sgHandleClearData(button) {
    if (button.dataset.pending !== "true") {
        button.dataset.pending = "true";
        button.dataset.idleLabel = button.textContent;
        button.textContent = "Nhấn lần nữa để xác nhận";
        clearTimeout(sgClearTimer);
        sgClearTimer = setTimeout(() => sgResetClearAction(button), 6000);
        return;
    }
    clearTimeout(sgClearTimer);
    sgResetClearAction(button);
    const report = sgStorageReport();
    report.temporary.forEach(key => { try { localStorage.removeItem(key); } catch {} });
    try {
        if (window.caches && typeof window.caches.keys === "function") {
            window.caches.keys().then(names => names.forEach(name => window.caches.delete(name))).catch(() => {});
        }
    } catch {}
    sgRenderStorage();
    settingsFeedbackFor("settingsDataFeedback", report.temporary.length
        ? `Đã xóa ${report.temporary.length} mục dữ liệu tạm. Phiên đăng nhập và cài đặt được giữ nguyên.`
        : "Không có dữ liệu tạm để xóa.", "success");
}

function sgExportSettings() {
    const payload = {
        app: "SentinelGate",
        type: "sentinelgate-settings",
        version: 1,
        exportedAt: new Date().toISOString(),
        settings: { ...sgPrefs }
    };
    try {
        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = `sentinelgate-settings-${new Date().toISOString().slice(0, 10)}.json`;
        document.body.append(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        settingsFeedbackFor("settingsDataFeedback", "Đã xuất tệp cài đặt (.json).", "success");
    } catch {
        settingsFeedbackFor("settingsDataFeedback", "Không thể xuất cài đặt trên thiết bị này.", "error");
    }
}

function sgImportSettingsFile(file) {
    if (!file) return;
    if (file.size > 65536) {
        settingsFeedbackFor("settingsDataFeedback", "Tệp cài đặt vượt quá 64 KB nên bị từ chối.", "error");
        return;
    }
    const reader = new FileReader();
    reader.onload = () => {
        let parsed = null;
        try { parsed = JSON.parse(String(reader.result || "")); } catch { parsed = null; }
        const candidate = parsed && typeof parsed === "object" && parsed.settings && typeof parsed.settings === "object"
            ? parsed.settings
            : parsed;
        if (!candidate || typeof candidate !== "object") {
            settingsFeedbackFor("settingsDataFeedback", "Tệp không phải cài đặt SentinelGate hợp lệ.", "error");
            return;
        }
        sgPrefs = sgSanitizePrefs(candidate);
        sgPersistPrefs();
        sgApplyPrefs();
        sgRenderAppearance();
        sgRenderStorage();
        settingsFeedbackFor("settingsDataFeedback", "Đã nhập cài đặt và áp dụng ngay.", "success");
    };
    reader.onerror = () => settingsFeedbackFor("settingsDataFeedback", "Không đọc được tệp cài đặt.", "error");
    reader.readAsText(file);
}

document.getElementById("settingDarkMode")?.addEventListener("click", () => {
    const oled = sgPrefs.darkMode !== "oled";
    sgSetPreference("darkMode", oled ? "oled" : "default");
    settingsFeedbackFor("settingsAppearanceFeedback", oled
        ? "Đã bật chế độ tối nền đen sâu (OLED)."
        : "Đã trở về chủ đề tối mặc định.", "success");
});

document.getElementById("settingEffects")?.addEventListener("click", () => {
    const reduced = sgPrefs.effects !== "reduced";
    sgSetPreference("effects", reduced ? "reduced" : "full");
    settingsFeedbackFor("settingsAppearanceFeedback", reduced
        ? "Đã giảm hiệu ứng mờ để nhẹ máy hơn."
        : "Đã bật lại hiệu ứng mờ đầy đủ.", "success");
});

document.getElementById("chooseBackgroundImage")?.addEventListener("click", () => document.getElementById("backgroundImageInput")?.click());
document.getElementById("chooseBackgroundVideo")?.addEventListener("click", () => document.getElementById("backgroundVideoInput")?.click());
document.getElementById("clearCustomBackground")?.addEventListener("click", sgRemoveCustomBackground);
document.getElementById("backgroundImageInput")?.addEventListener("change", event => {
    const input = event.currentTarget;
    sgSaveSelectedBackground(input.files?.[0], "image");
    input.value = "";
});
document.getElementById("backgroundVideoInput")?.addEventListener("change", event => {
    const input = event.currentTarget;
    sgSaveSelectedBackground(input.files?.[0], "video");
    input.value = "";
});

document.querySelectorAll(".settings-choices[data-setting]").forEach(group => {
    group.addEventListener("click", event => {
        const button = event.target.closest("button[data-value]");
        if (!button || !group.contains(button)) return;
        const key = group.dataset.setting;
        const labels = { accent: "điểm nhấn neon", fontSize: "cỡ chữ" };
        if (sgSetPreference(key, button.dataset.value)) {
            settingsFeedbackFor("settingsAppearanceFeedback", `Đã đổi ${labels[key] || key}.`, "success");
        }
    });
});

document.getElementById("clearSettingsData")?.addEventListener("click", event => sgHandleClearData(event.currentTarget));

document.getElementById("resetSettingsPrefs")?.addEventListener("click", () => {
    sgPrefs = { ...SG_PREF_DEFAULTS };
    sgPersistPrefs();
    sgApplyPrefs();
    sgRenderAppearance();
    sgRenderStorage();
    settingsFeedbackFor("settingsDataFeedback", "Đã đặt lại cài đặt về mặc định.", "success");
});

document.getElementById("exportSettings")?.addEventListener("click", () => {
    sgExportSettings();
});

document.getElementById("importSettings")?.addEventListener("click", () => {
    document.getElementById("settingsImportInput")?.click();
});

document.getElementById("settingsImportInput")?.addEventListener("change", event => {
    const input = event.currentTarget;
    sgImportSettingsFile(input.files && input.files[0] ? input.files[0] : null);
    input.value = "";
});

sgApplyPrefs();


initSettingsTab();
const ABOUT_PROJECT_INFO = {
    projectName: "SentinelGate",
    version: SENTINELGATE_VERSION,
    description: "Bảo vệ tệp an toàn",

    team: {
        name: "2DG",
        members: [
            {
                name: "Phạm Duy Chí Vỹ",
                role: "Developer",
                links: {
                    facebook: "https://www.facebook.com/share/1BNsxbHi7Q/",
                    github: "https://github.com/pdcv2010",
                    email: "mailto:chivy2212010@gmail.com",
                    discord: "https://discord.com/users/1244158348195139624"
                }
            },
            {
                name: "Vũ Mai Linh",
                role: "Developer",
                links: {
                    facebook: "https://www.facebook.com/share/19dh5paDwU/",
                    github: "https://github.com/mailinhvu1310-collab",
                    email: "mailto:mailinhvu1310@gmail.com",
                    discord: "https://discord.com/users/1297954161865789492"
                }
            }
        ]
    }
};

const ABOUT_TIMING = {
    startDelay: 500,
    typeMs: 11,
    lineMs: 60,
    checkMs: 55,
    pauseMs: 200,
    logFadeMs: 240,
    artMs: 300,
    wordMs: 240,
    ruleMs: 160
};


/* =====================================================
   BOOT SEQUENCE
   Nội dung giả lập khởi động hệ thống — chỉ MÔ TẢ các module thật của
   SentinelGate (core C++, backend, storage).
   ===================================================== */
const ABOUT_BOOT = {
    command: "init sentinelgate",
    lines: [
        "đang nạp nhân hệ điều hành...",
        "đang gắn hệ thống tệp an toàn...",
        "đang kiểm tra mô-đun mã hóa...",
        "đang nạp bộ phân tích âm thanh...",
        "đang khởi tạo bộ phân mảnh...",
        "đang bắt đầu xác minh tính toàn vẹn...",
        "đang nạp thông tin dự án..."
    ],
    checks: [
        ["bộ mã hóa", "SẴN SÀNG"],
        ["phân tích âm thanh", "SẴN SÀNG"],
        ["bộ phân mảnh", "SẴN SÀNG"],
        ["hệ thống lưu trữ", "SẴN SÀNG"],
        ["xác minh tính toàn vẹn", "SẴN SÀNG"]
    ]
};

/* =====================================================
   NỘI DUNG TĨNH CỦA CÁC TERMINAL CON
   Chỉ liệt kê những gì dự án THẬT SỰ đang có (core C++ + backend).
   ===================================================== */
const ABOUT_PIPELINE = [
    { title: "TỆP ĐẦU VÀO", detail: "tệp gốc người dùng chọn, gửi lên qua multer" },
    { title: "PHÂN TÍCH ÂM THANH", detail: "aubio đọc bài nhạc để lấy danh sách nhịp" },
    { title: "PHÂN MẢNH", detail: "số nhịp quyết định số phân mảnh, phần dư ở mảnh cuối" },
    { title: "MÃ HÓA AES-256-CBC", detail: "khóa 256-bit = SHA-256(mật khẩu), IV 16 byte ngẫu nhiên" },
    { title: "TÍNH TOÀN VẸN HMAC-SHA256", detail: "mỗi phân mảnh được gắn HMAC-SHA256" },
    { title: "LƯU MẢNH NGẪU NHIÊN", detail: "thứ tự mảnh được xáo trộn, tên tệp ngẫu nhiên" },
    { title: "KHÔI PHỤC", detail: "xác thực HMAC, giải mã, ghép mảnh, đối chiếu SHA-256" }
];

/* [nhãn, giá trị hoặc khoá trong ABOUT_PROJECT_INFO, isSecondary]
   isSecondary = dòng phụ, tự ẩn trên màn hình nhỏ để không tràn. */
const ABOUT_PRODUCT_ROWS = [
    ["Tên dự án", "projectName", false],
    ["Phiên bản", "version", false],
    ["Loại", "description", false],
    ["Lõi", "C++", false],
    ["Mã hóa", "OpenSSL", false],
    ["Âm thanh", "aubio", true],
    ["Máy chủ", "Node.js / Express", false],
    ["Cơ sở dữ liệu", "PostgreSQL", true],
    ["API", "FastAPI", true],
    ["Giao diện", "HTML / CSS / JavaScript", true]
];

const ABOUT_TEAM_LINKS = [
    { key: "discord", label: "Discord" },
    { key: "email", label: "email" },
    { key: "facebook", label: "Facebook" },
    { key: "github", label: "GitHub" }
];

/* =====================================================
   ABOUT TERMINAL TREE
   Each step describes a split of the clicked leaf only. The existing leaf
   remains the first child; its sibling terminals keep their current state.
   ===================================================== */
const ABOUT_STEPS = [
    { dir: "row", existingRole: "pipeline", existingNext: 3, adds: "logo", addedNext: 1 },
    { dir: "column", existingRole: "logo", existingNext: null, adds: "product", addedNext: 2 },
    { dir: "row", existingRole: "product", existingNext: null, adds: "team", addedNext: null },
    { dir: "column", existingRole: "pipeline", existingNext: null, adds: "binary", addedNext: 4 },
    { dir: "row", existingRole: "binary", existingNext: null, adds: "exit", addedNext: null }
];

/* =====================================================
   TRẠNG THÁI + HÀM PHỤ TRỢ
   `generation` tăng mỗi khi rời trang / bắt đầu lại: mọi vòng lặp gõ
   chữ đều kiểm tra và tự dừng, nên không có animation "chạy mãi".
   ===================================================== */
const ABOUT_UI = {
    ready: false,
    page: null,
    stage: null,
    root: null,
    generation: 0,
    visible: false,
    busy: false,
    observer: null,
    clickTimer: null,
    history: []
};

function aboutEsc(value) {
    return String(value === null || value === undefined ? "" : value).replace(/[&<>"']/g, character => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[character]));
}

/* Người dùng có bật "giảm chuyển động" không? */
function aboutReduced() {
    return Boolean(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
}

function aboutWait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/* Nghỉ `ms`; trả về true nếu animation đã bị huỷ (generation đổi). */
async function aboutHold(ms, generation) {
    if (aboutReduced()) return generation !== ABOUT_UI.generation;
    await aboutWait(ms);
    return generation !== ABOUT_UI.generation;
}

/* Username THẬT từ session đã lưu (localStorage "user"), không hardcode. */
function aboutUser() {
    try {
        const user = typeof readCachedUser === "function" ? readCachedUser() : null;
        const name = user && (user.username || user.email);
        return name ? String(name) : "sentinelgate";
    } catch (error) {
        return "sentinelgate";
    }
}

function aboutPrompt(host) {
    return `${aboutUser()}@${host}:~$`;
}

/* =====================================================
   CẤU TRÚC TERMINAL
   Mỗi terminal là 1 <section class="sgx-leaf">: thanh tiêu đề + màn hình.
   Nội dung màn hình do builder của từng loại terminal sinh ra.
   ===================================================== */
const ABOUT_LEAF_META = {
    /* Bar title = kiểu "user@host:~" (§2/§6); dấu $ chỉ nằm ở prompt. */
    boot: { path: () => "sentinelgate@about:~", label: "Terminal khởi động SentinelGate", body: aboutBootBody },
    pipeline: { path: () => "sentinelgate@cach-hoat-dong:~", label: "Cách SentinelGate hoạt động", body: aboutPipelineBody },
    product: { path: () => "sentinelgate@he-thong:~", label: "Thông tin sản phẩm", body: aboutProductBody },
    team: { path: () => "sentinelgate@doi-ngu:~", label: "Đội ngũ phát triển", body: aboutTeamBody },
    logo: { path: () => "sentinelgate@logo:~", label: "Logo SentinelGate", body: aboutLogoBody },
    binary: { path: () => "sentinelgate@du-lieu-ma-hoa:~", label: "Dữ liệu mã hóa", body: aboutEncryptionBody },
    exit: { path: () => "sentinelgate@exit:~", label: "Exit icon", body: aboutExitBody }
};

function aboutLogoBody() {
    return `<div class="sgx-brand-art" aria-label="SentinelGate">`
        + `<img class="sgx-brand-logo" src="assets/sentinelgate-logo.png" alt="Biểu trưng SentinelGate">`
        + `<img class="sgx-brand-wordmark" src="assets/sentinelgate-wordmark.jpeg" alt="SentinelGate">`
        + `</div>`;
}

function aboutLeafMarkup(role) {
    const meta = ABOUT_LEAF_META[role];
    if (role === "exit") return `<div class="sgx-screen">${meta.body()}</div>`;
    return `<header class="sgx-bar">`
        + `<span class="sgx-bar-dots" aria-hidden="true"><i></i><i></i><i></i></span>`
        + `<span class="sgx-bar-path">${aboutEsc(meta.path())}</span>`
        + `<span class="sgx-bar-hint" aria-hidden="true">nhấp để mở rộng</span>`
        + `<span class="sgx-bar-cue" aria-hidden="true">&gt;</span>`
        + `</header>`
        + `<div class="sgx-screen">${meta.body()}</div>`;
}

function aboutLeaf(role) {
    const leaf = document.createElement("section");
    leaf.className = "sgx-leaf";
    leaf.dataset.role = role;
    leaf.innerHTML = aboutLeafMarkup(role);
    return leaf;
}

function aboutSetLeafRole(leaf, role) {
    if (!leaf || !ABOUT_LEAF_META[role]) return;
    leaf.dataset.role = role;
    leaf.classList.remove("is-ready", "is-glitch");
    leaf.innerHTML = aboutLeafMarkup(role);
}

/* =====================================================
   NỘI DUNG TỪNG TERMINAL
   ===================================================== */

/* Terminal boot: command log, real brand images, and an idle prompt. */
function aboutBootBody() {
    const ps1 = aboutEsc(aboutPrompt("about"));
    return `<div class="sgx-log" data-log aria-hidden="true">`
        + `<p class="sgx-line is-cmd"><span class="sgx-ps1">${ps1}</span><span class="sgx-typed" data-typed></span><span class="sgx-caret" data-caret>█</span></p>`
        + `</div>`
        + `<div class="sgx-brand-art is-off" data-art aria-label="SentinelGate">`
        + `<img class="sgx-brand-logo is-off" data-emblem src="assets/sentinelgate-logo.png" alt="Biểu trưng SentinelGate">`
        + `<img class="sgx-brand-wordmark is-off" data-word src="assets/sentinelgate-wordmark.jpeg" alt="SentinelGate">`
        + `</div>`
        + `<p class="sgx-line sgx-ready is-off" data-ready><span class="sgx-ps1">${ps1}</span><span class="sgx-caret" aria-hidden="true">█</span></p>`
        + `<p class="sgx-sr">SentinelGate — Bảo vệ tệp an toàn. Nhấn vào terminal để mở rộng.</p>`;
}

/* Terminal pipeline: 7 bước thật của quá trình bảo vệ/khôi phục. */
function aboutPipelineBody() {
    const last = ABOUT_PIPELINE.length - 1;
    const steps = ABOUT_PIPELINE.map((step, index) =>
        `<li class="sgx-step" style="--i:${index}">`
        + `<span class="sgx-step-n">${String(index + 1).padStart(2, "0")}</span>`
        + `<span class="sgx-step-t">${aboutEsc(step.title)}</span>`
        + `<span class="sgx-step-d">${aboutEsc(step.detail)}</span>`
        + (index < last ? `<span class="sgx-arrow" aria-hidden="true">↓</span>` : "")
        + `</li>`).join("");
    return `<div class="sgx-content">`
        + `<p class="sgx-head">${aboutEsc(ABOUT_PROJECT_INFO.projectName.toUpperCase())} <span>//</span> CÁCH HOẠT ĐỘNG</p>`
        + `<p class="sgx-cmd">$ ./explain --architecture</p>`
        + `<ol class="sgx-pipe">${steps}</ol>`
        + `</div>`;
}

const ABOUT_BINARY_LINES = [
    "010101101001", "101001011010", "001101010111", "110010100101",
    "010111001010", "101100101101", "011010110010", "100101001110",
    "001011101001", "111000101011", "010010111001", "101101000110"
];

function aboutEncryptionBody() {
    const columns = Array.from({ length: 6 }, (_, index) => {
        const lines = ABOUT_BINARY_LINES.map((line, row) => {
            if ((index + row) % 2 === 0) return line;
            return line.slice(index % 5) + line.slice(0, index % 5);
        });
        const stream = Array.from({ length: 4 }, () => lines.join("\n")).join("\n");
        return `<div class="sgx-binary-column"><div class="sgx-binary-stream" style="--i:${index}">${stream}</div></div>`;
    }).join("");
    return `<div class="sgx-binary-grid" aria-hidden="true">${columns}</div>`;
}

function aboutExitBody() {
    return `<div class="sgx-exit-wrap"><button class="sgx-exit-button" type="button" aria-label="Thoát About">`
        + `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">`
        + `<path d="M14 4h5v16h-5M3 12h11m-4-4 4 4-4 4"/>`
        + `</svg></button></div>`;
}

/* Một dòng "khoá ..... giá trị" của terminal. */
function aboutKV(label, value, secondary) {
    const text = String(value === null || value === undefined ? "" : value);
    const todo = /^\[CHƯA CẬP NHẬT/i.test(text) ? " is-todo" : "";
    return `<div class="sgx-row${secondary ? " is-secondary" : ""}">`
        + `<span class="sgx-row-k">${aboutEsc(label)}</span>`
        + `<span class="sgx-row-lead"></span>`
        + `<span class="sgx-row-v${todo}">${aboutEsc(text)}</span>`
        + `</div>`;
}

/* Terminal thông tin sản phẩm: chỉ công nghệ dự án đang dùng thật. */
function aboutProductBody() {
    const rows = ABOUT_PRODUCT_ROWS.map(row => {
        const key = row[1];
        const value = Object.prototype.hasOwnProperty.call(ABOUT_PROJECT_INFO, key) ? ABOUT_PROJECT_INFO[key] : key;
        return aboutKV(row[0], value, row[2]);
    }).join("");
    return `<div class="sgx-content">`
        + `<p class="sgx-head">THÔNG TIN SẢN PHẨM</p>`
        + `<p class="sgx-cmd">$ sentinelgate --info</p>`
        + `<div class="sgx-kv">${rows}</div>`
        + `</div>`;
}

/* Terminal đội ngũ: chọn thành viên trước khi kích hoạt liên hệ. */
function aboutTeamContactsMarkup(member) {
    const links = member?.links || {};
    return ABOUT_TEAM_LINKS.map(item => {
        const href = String(links[item.key] || "").trim();
        const safeHref = /^(https?:\/\/|mailto:)/i.test(href);
        if (member && safeHref) {
            const target = href.startsWith("mailto:") ? "" : ' target="_blank" rel="noopener noreferrer"';
            return `<a class="sgx-chip" href="${aboutEsc(href)}"${target}>[ ${aboutEsc(item.label)} ]</a>`;
        }
        return `<span class="sgx-chip is-todo" aria-disabled="true" tabindex="-1">[ ${aboutEsc(item.label)} ]</span>`;
    }).join("");
}

function aboutRenderTeamSelection(teamRoot, index = null) {
    if (!teamRoot) return;
    const team = ABOUT_PROJECT_INFO.team;
    const selectedIndex = Number.isInteger(index) && team.members[index] ? index : null;
    if (selectedIndex === null) delete teamRoot.dataset.selectedMember;
    else teamRoot.dataset.selectedMember = String(selectedIndex);
    teamRoot.querySelectorAll(".sgx-member-button").forEach(button => {
        const selected = Number(button.dataset.teamIndex) === selectedIndex;
        button.classList.toggle("is-selected", selected);
        button.setAttribute("aria-pressed", String(selected));
    });
    const member = selectedIndex === null ? null : team.members[selectedIndex];
    const contacts = teamRoot.querySelector(".sgx-chips");
    if (contacts) contacts.innerHTML = aboutTeamContactsMarkup(member);
    const hint = teamRoot.querySelector(".sgx-team-select-hint");
    if (hint) hint.textContent = member
        ? `$ thông tin liên hệ: ${member.name} — ${member.role}`
        : "$ chọn thành viên để xem thông tin liên hệ";
}

function aboutTeamBody() {
    const team = ABOUT_PROJECT_INFO.team;
    const members = team.members.map((member, index) =>
        `<li class="sgx-member" style="--i:${index}"><button class="sgx-member-button" type="button" data-team-index="${index}" aria-pressed="false">${aboutEsc(member.name)}<span class="sgx-member-role">${aboutEsc(member.role)}</span></button></li>`).join("");
    return `<div class="sgx-content sgx-team-content">`
        + `<p class="sgx-head">ĐỘI NGŨ PHÁT TRIỂN</p>`
        + `<p class="sgx-cmd">$ whoami --team</p>`
        + `<div class="sgx-kv">`
        + aboutKV("Đội ngũ", team.name, false)
        + aboutKV("Dự án", ABOUT_PROJECT_INFO.projectName, false)
        + `</div>`
        + `<ul class="sgx-members">${members}</ul>`
        + `<div class="sgx-chips">${aboutTeamContactsMarkup(null)}</div>`
        + `<p class="sgx-team-select-hint" role="status" aria-live="polite">$ chọn thành viên để xem thông tin liên hệ</p>`
        + `</div>`;
}

/* =====================================================
   BOOT SEQUENCE — chỉ chạy MỘT lần sau mỗi lần mở About.
   Khi logo + wordmark ảnh đã hiện thì DỪNG HOÀN TOÀN:
   không timer chạy tiếp, không interval, không tự tách terminal.
   Người dùng phải nhấn vào terminal mới đi tiếp (§8 của spec).
   ===================================================== */
function aboutAppendLine(log, html, className) {
    if (!log) return null;
    const line = document.createElement("p");
    line.className = "sgx-line is-new" + (className ? " " + className : "");
    line.innerHTML = html;
    log.appendChild(line);
    return line;
}

/* Gõ từng ký tự bằng setTimeout CÓ THỂ HUỶ (không dùng setInterval). */
async function aboutType(node, text, generation) {
    if (!node) return false;
    const value = String(text);
    if (aboutReduced()) { node.textContent = value; return true; }
    node.textContent = "";
    for (let index = 0; index < value.length; index += 1) {
        if (generation !== ABOUT_UI.generation) return false;
        node.textContent = value.slice(0, index + 1);
        await aboutWait(ABOUT_TIMING.typeMs);
    }
    return true;
}

function aboutCheckLine(label, value) {
    return `<span class="sgx-tag">[ OK ]</span><span>${aboutEsc(label)}</span>`
        + `<span class="sgx-lead"></span><span class="sgx-value">${aboutEsc(value)}</span>`;
}

/* Glitch RẤT NGẮN (~200ms) khi terminal được kích hoạt (§18). */
function aboutGlitch(leaf) {
    if (!leaf || aboutReduced()) return;
    leaf.classList.add("is-glitch");
    window.setTimeout(() => leaf.classList.remove("is-glitch"), 220);
}

async function aboutRunBoot(generation) {
    const root = ABOUT_UI.root;
    if (!root) return;
    const log = root.querySelector("[data-log]");
    const typed = root.querySelector("[data-typed]");
    const caret = root.querySelector("[data-caret]");
    const art = root.querySelector("[data-art]");
    const ready = root.querySelector("[data-ready]");

    /* §3: đợi ~500ms rồi mới boot */
    if (await aboutHold(ABOUT_TIMING.startDelay, generation)) return;

    /* Lệnh gõ từng ký tự (10-20ms/ký tự, §4) */
    if (!await aboutType(typed, ABOUT_BOOT.command, generation)) return;
    if (caret) caret.remove();

    /* Các dòng log hiện lần lượt -> tổng thời lượng boot giữ ~1 giây */
    for (let index = 0; index < ABOUT_BOOT.lines.length; index += 1) {
        if (await aboutHold(ABOUT_TIMING.lineMs, generation)) return;
        aboutAppendLine(log, `<span class="sgx-marker">$</span><span>${aboutEsc(ABOUT_BOOT.lines[index])}</span>`);
    }
    for (let index = 0; index < ABOUT_BOOT.checks.length; index += 1) {
        if (await aboutHold(ABOUT_TIMING.checkMs, generation)) return;
        aboutAppendLine(log, aboutCheckLine(ABOUT_BOOT.checks[index][0], ABOUT_BOOT.checks[index][1]), "is-check");
    }

    /* §5: dừng ~200ms rồi mới hiện logo */
    if (await aboutHold(ABOUT_TIMING.pauseMs, generation)) return;

    /* Xoá log boot để terminal tối giản đúng §8 (logo + wordmark + prompt) */
    if (log) log.classList.add("is-fading");
    if (await aboutHold(ABOUT_TIMING.logFadeMs, generation)) return;
    if (log) log.classList.add("is-off");

    /* Show the real SentinelGate logo image. */
    if (art) art.classList.remove("is-off");
    aboutGlitch(root);
    const emblem = root.querySelector("[data-emblem]");
    if (emblem) emblem.classList.remove("is-off");
    if (await aboutHold(ABOUT_TIMING.artMs, generation)) return;

    /* Show the real wordmark image without changing its aspect ratio. */
    const word = root.querySelector("[data-word]");
    if (word) word.classList.remove("is-off");
    if (await aboutHold(ABOUT_TIMING.wordMs, generation)) return;

    /* §8: DỪNG. Prompt + con trỏ CSS nhấp nháy, chờ người dùng nhấn. */
    if (ready) ready.classList.remove("is-off");
    root.classList.add("is-ready");
    aboutArmLeaf(root, 0);
}



/* =====================================================
   TASK SWITCHING / SPLIT TREE
   Nhấn vào 1 terminal: nó tách thành 2. Terminal đang có GIỮ NGUYÊN
   nội dung, terminal mới xuất hiện ở vị trí thứ hai. A snapshot is kept
   before each split so double-click can restore the exact prior tree.
   Trong lúc tách, `ABOUT_UI.busy = true` nên mọi nhấn thêm đều bị bỏ
   qua -> không thể nhấn liên tục để tạo terminal trùng.
   ===================================================== */
function aboutArmLeaf(leaf, step) {
    if (!leaf) return;
    const meta = ABOUT_LEAF_META[leaf.dataset.role] || {};
    if (step === null || step === undefined) {
        leaf.removeAttribute("data-step");
        leaf.removeAttribute("tabindex");
        leaf.removeAttribute("role");
        leaf.removeAttribute("aria-label");
        leaf.classList.remove("is-open");
        return;
    }
    leaf.dataset.step = String(step);
    leaf.setAttribute("tabindex", "0");
    leaf.setAttribute("role", "button");
    leaf.setAttribute("aria-label", `${meta.label || "Terminal"} — nhấn để mở rộng`);
    leaf.classList.add("is-open");
}

function aboutSplit(leaf) {
    if (!leaf || ABOUT_UI.busy) return;
    const stepIndex = Number(leaf.dataset.step);
    if (!Number.isInteger(stepIndex)) return;
    const step = ABOUT_STEPS[stepIndex];
    const parent = leaf.parentNode;
    if (!step || !parent || !ABOUT_UI.stage) return;
    if (!parent.classList.contains("sgx-stage") && !parent.classList.contains("sgx-split")) return;

    const reduced = aboutReduced();
    ABOUT_UI.history.push(ABOUT_UI.stage.innerHTML);
    ABOUT_UI.busy = true;
    aboutGlitch(leaf);

    const split = document.createElement("div");
    split.className = "sgx-split";
    split.dataset.dir = step.dir;
    parent.replaceChild(split, leaf);

    /* Reuse the clicked node as child one, and create only its new sibling. */
    aboutSetLeafRole(leaf, step.existingRole);
    const added = aboutLeaf(step.adds);
    if (stepIndex === 0) {
        /* The requested first row is Logo | Cách hoạt động. */
        split.appendChild(added);
        split.appendChild(leaf);
    } else {
        split.append(leaf, added);
    }
    aboutArmLeaf(leaf, step.existingNext);
    aboutArmLeaf(added, step.addedNext);

    if (reduced) {
        ABOUT_UI.busy = false;
        return;
    }
    split.classList.add("is-splitting");
    window.setTimeout(() => split.classList.remove("is-splitting"), 620);
    window.setTimeout(() => { ABOUT_UI.busy = false; }, 420);
}

/* Restore exactly one previously visible terminal tree. */
function aboutGoBack() {
    if (ABOUT_UI.clickTimer) {
        window.clearTimeout(ABOUT_UI.clickTimer);
        ABOUT_UI.clickTimer = null;
    }
    if (!ABOUT_UI.history.length || !ABOUT_UI.stage) return;
    ABOUT_UI.busy = false;
    ABOUT_UI.stage.innerHTML = ABOUT_UI.history.pop();
    ABOUT_UI.root = ABOUT_UI.stage.querySelector('.sgx-leaf[data-role="boot"]');
    ABOUT_UI.busy = false;
}

/* =====================================================
   VÒNG ĐỜI TRANG ABOUT
   Mở About -> reset về 1 terminal và chạy lại boot (§2).
   Rời About -> tăng `generation` để huỷ mọi animation đang chạy.
   ===================================================== */
function aboutReset() {
    const stage = ABOUT_UI.stage;
    if (!stage) return null;
    if (ABOUT_UI.clickTimer) window.clearTimeout(ABOUT_UI.clickTimer);
    ABOUT_UI.clickTimer = null;
    ABOUT_UI.history = [];
    stage.textContent = "";
    const root = aboutLeaf("boot");
    stage.appendChild(root);
    ABOUT_UI.root = root;
    ABOUT_UI.busy = false;
    return root;
}

function aboutStart() {
    ABOUT_UI.generation += 1;
    aboutReset();
    aboutRunBoot(ABOUT_UI.generation).catch(() => {});
}

function aboutStop() {
    ABOUT_UI.generation += 1;
    ABOUT_UI.busy = false;
    if (ABOUT_UI.clickTimer) window.clearTimeout(ABOUT_UI.clickTimer);
    ABOUT_UI.clickTimer = null;
}

function aboutObserve() {
    const page = ABOUT_UI.page;
    if (!page) return;
    const visible = !page.classList.contains("hidden") && page.classList.contains("is-active");
    if (visible === ABOUT_UI.visible) return;
    ABOUT_UI.visible = visible;
    if (visible) aboutStart();
    else aboutStop();
}

function aboutEnsureInit() {
    if (ABOUT_UI.ready) return;
    const page = document.getElementById("aboutPage");
    const stage = document.getElementById("aboutStage");
    if (!page || !stage) return;
    ABOUT_UI.page = page;
    ABOUT_UI.stage = stage;

    /* Delay single-click briefly so a double-click can navigate back. */
    stage.addEventListener("click", event => {
        const memberButton = event.target && event.target.closest ? event.target.closest(".sgx-member-button") : null;
        if (memberButton && stage.contains(memberButton)) {
            event.preventDefault();
            event.stopPropagation();
            const teamRoot = memberButton.closest('.sgx-leaf[data-role="team"]');
            if (teamRoot) aboutRenderTeamSelection(teamRoot, Number(memberButton.dataset.teamIndex));
            return;
        }
        const exitButton = event.target && event.target.closest ? event.target.closest(".sgx-exit-button") : null;
        if (exitButton && stage.contains(exitButton)) {
            event.preventDefault();
            event.stopPropagation();
            if (exitButton.disabled) return;
            exitButton.disabled = true;
            selectHomeSection("Trang chủ");
            return;
        }
        const leaf = event.target && event.target.closest ? event.target.closest(".sgx-leaf[data-step]") : null;
        if (!leaf || !stage.contains(leaf)) return;
        if (ABOUT_UI.clickTimer) window.clearTimeout(ABOUT_UI.clickTimer);
        ABOUT_UI.clickTimer = window.setTimeout(() => {
            ABOUT_UI.clickTimer = null;
            aboutSplit(leaf);
        }, 240);
    });
    page.addEventListener("dblclick", event => {
        if (page.classList.contains("hidden")) return;
        if (event.target?.closest?.(".sgx-exit-button")) {
            event.preventDefault();
            event.stopPropagation();
            return;
        }
        event.preventDefault();
        aboutGoBack();
    });
    stage.addEventListener("keydown", event => {
        if (event.key !== "Enter" && event.key !== " ") return;
        const leaf = event.target && event.target.closest ? event.target.closest(".sgx-leaf[data-step]") : null;
        if (!leaf || !stage.contains(leaf)) return;
        event.preventDefault();
        aboutSplit(leaf);
    });

    /* §24: About không có scrollbar — chặn luôn lăn chuột khi đang mở.
       Chỉ gắn trên #aboutPage nên không ảnh hưởng các trang khác. */
    page.addEventListener("wheel", event => {
        if (page.classList.contains("hidden")) return;
        event.preventDefault();
    }, { passive: false });

    ABOUT_UI.observer = new MutationObserver(aboutObserve);
    ABOUT_UI.observer.observe(page, { attributes: true, attributeFilter: ["class"] });
    ABOUT_UI.ready = true;
    aboutObserve();
}

aboutEnsureInit();

/* ------------------------------------------------------------------
   Liquid glass entry choreography.
   Purely presentational: it only watches the class changes the existing
   tab system already performs and adds one temporary class to the active
   tab root. Navigation, data and timing are untouched.
   ------------------------------------------------------------------ */
let sgEntranceRoot = null;
let sgEntrancePlayed = false;
let sgEntranceTimer = null;

function sgActiveTabView() {
    return tabViews.find(view => view.classList.contains("is-active") && !view.classList.contains("hidden")) || null;
}

function sgPlayEntrance(root) {
    if (!root) return;
    root.classList.remove("sg-entering");
    void root.offsetWidth;
    root.classList.add("sg-entering");
    clearTimeout(sgEntranceTimer);
    sgEntranceTimer = setTimeout(() => {
        if (sgEntranceRoot) sgEntranceRoot.classList.remove("sg-entering");
    }, 1700);
}

function sgRefreshEntrance() {
    if (pages.home.classList.contains("hidden")) {
        if (sgEntranceRoot) sgEntranceRoot.classList.remove("sg-entering");
        sgEntranceRoot = null;
        sgEntrancePlayed = false;
        return;
    }
    const view = sgActiveTabView();
    if (!view) return;
    const root = view.dataset.homeTab === "Trang chủ" ? pages.home : view;
    if (root !== sgEntranceRoot) {
        if (sgEntranceRoot) sgEntranceRoot.classList.remove("sg-entering");
        sgEntranceRoot = root;
        sgEntrancePlayed = false;
    }
    if (sgEntrancePlayed) return;
    sgEntrancePlayed = true;
    sgPlayEntrance(root);
}

const sgEntranceObserver = new MutationObserver(sgRefreshEntrance);
tabViews.forEach(view => sgEntranceObserver.observe(view, { attributes: true, attributeFilter: ["class"] }));
sgEntranceObserver.observe(pages.home, { attributes: true, attributeFilter: ["class"] });
sgRefreshEntrance();
