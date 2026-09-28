(function (global) {
    "use strict";

    const API_BASE = String(global.API_BASE_URL || "").replace(/\/$/, "");
    if (!API_BASE) throw new Error("Missing API_BASE_URL. Check the root config.js file.");
    const PUBLIC_ENDPOINTS = new Set(["/auth/register", "/auth/login", "/health"]);
    let sessionEpoch = 0;
    let unauthorizedHandled = false;

    class ApiError extends Error {
        constructor(message, status, payload) {
            super(message);
            this.name = "ApiError";
            this.status = status;
            this.payload = payload;
            this.code = payload?.error?.code || payload?.code;
        }
    }

    async function apiRequest(endpoint, options = {}) {
        const method = options.method || "GET";
        const headers = new Headers(options.headers || {});
        const isFormData = typeof FormData !== "undefined" && options.body instanceof FormData;
        let body = options.body;

        if (body !== undefined && body !== null && !isFormData && typeof body !== "string" && !(body instanceof Blob)) {
            body = JSON.stringify(body);
            if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");
        }
        if (!headers.has("Accept")) headers.set("Accept", options.responseType === "blob" ? "*/*" : "application/json");

        const requiresAuth = options.auth ?? !PUBLIC_ENDPOINTS.has(endpoint);
        const requestEpoch = sessionEpoch;
        const token = localStorage.getItem("access_token");
        if (requiresAuth && token) headers.set("Authorization", `Bearer ${token}`);

        const requestSignal = options.signal || AbortSignal.timeout(options.timeoutMs || 15000);
        const response = await fetch(`${API_BASE}${endpoint}`, {
            method,
            headers,
            body,
            signal: requestSignal
        });

        let payload;
        if (options.responseType === "blob") {
            if (!response.ok) {
                try { payload = await response.clone().json(); } catch { payload = {}; }
            } else {
                if (requiresAuth && requestEpoch !== sessionEpoch) throw expiredSessionError();
                return response;
            }
        } else {
            const contentType = response.headers.get("content-type") || "";
            payload = contentType.includes("application/json") ? await response.json() : await response.text();
        }

        if (!response.ok) {
            const error = new ApiError(payload?.error?.message || payload?.message || `Yêu cầu thất bại (${response.status}).`, response.status, payload);
            // A late response for an old token must not log out a newer session.
            if (response.status === 401 && requiresAuth && token === localStorage.getItem("access_token")) {
                error.sessionReason = token ? "expired" : "missing";
                invalidateSession(error.sessionReason);
            }
            throw error;
        }
        // Do not let requests started before session expiry update the current UI.
        if (requiresAuth && requestEpoch !== sessionEpoch) throw expiredSessionError();
        return payload;
    }

    function expiredSessionError() {
        return new ApiError("Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.", 401);
    }

    function invalidateSession(reason = "expired") {
        clearSession();
        if (unauthorizedHandled) return;
        unauthorizedHandled = true;
        sessionEpoch += 1;
        global.dispatchEvent(new CustomEvent("sentinelgate:unauthorized", { detail: { reason } }));
    }

    function saveSession(payload) {
        if (!payload?.token || !payload?.user) throw new ApiError("Phản hồi đăng nhập thiếu token hoặc thông tin người dùng.", 500, payload);
        localStorage.setItem("access_token", payload.token);
        localStorage.setItem("user", JSON.stringify(payload.user));
        unauthorizedHandled = false;
        return payload;
    }

    function clearSession() {
        localStorage.removeItem("access_token");
        localStorage.removeItem("user");
    }

    const client = {
        API_BASE,
        ApiError,
        apiRequest,
        async register({ username, email, password }) {
            return saveSession(await apiRequest("/auth/register", { method: "POST", body: { username, email, password } }));
        },
        async login({ email, password }) {
            return saveSession(await apiRequest("/auth/login", { method: "POST", body: { email, password } }));
        },
        logout: clearSession,
        health: () => apiRequest("/health", { auth: false }),
        session: () => apiRequest("/auth/session"),
        dashboardStats: (options = {}) => apiRequest("/dashboard/stats", options),
        protectionJobs: () => apiRequest("/protection/jobs"),
        restoreJobs: () => apiRequest("/restore/jobs"),
        createClientProtectionJob: files => apiRequest("/protection/client-jobs", { method: "POST", body: { files } }),
        completeClientProtectionJob: id => apiRequest(`/protection/client-jobs/${encodeURIComponent(id)}/complete`, { method: "POST", body: {} }),
        clientJobFragments: (id, fileIndex) => apiRequest(`/protection/client-jobs/${encodeURIComponent(id)}/files/${fileIndex}/fragments`),
        recordClientRestore: ({ protectJobId, fileIndex, sha256 }) => apiRequest("/restore/client-jobs", { method: "POST", body: { protectJobId, fileIndex, sha256 } }),
        searchMusic: (query, options = {}) => apiRequest(`/music/search?query=${encodeURIComponent(query)}`, options),
        async protectFiles(files, trackId, password) {
            const form = new FormData();
            files.forEach(file => form.append("files", file, file.name));
            form.append("trackId", trackId);
            form.append("password", password);
            return apiRequest("/protection/jobs", { method: "POST", body: form });
        },
        protectionJob: id => apiRequest(`/protection/jobs/${encodeURIComponent(id)}`),
        createRestoreJob: ({ jobId, fileIndex = 0, password }) => apiRequest("/restore/jobs", {
            method: "POST", body: { jobId, fileIndex, password }
        }),
        restoreJob: id => apiRequest(`/restore/jobs/${encodeURIComponent(id)}`),
        restoreDownload: id => apiRequest(`/restore/jobs/${encodeURIComponent(id)}/download`, { responseType: "blob" })
    };

    global.SentinelGateApi = client;
})(window);
