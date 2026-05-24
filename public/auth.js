const authTitle = document.querySelector("#auth-title");
const authDescription = document.querySelector("#auth-description");
const authStatus = document.querySelector("#auth-status");
const setupForm = document.querySelector("#setup-form");
const loginForm = document.querySelector("#login-form");
const setupPassword = document.querySelector("#setup-password");
const setupConfirmPassword = document.querySelector("#setup-confirm-password");
const loginPassword = document.querySelector("#login-password");
const redirectUrl = buildRedirectUrl();

boot();

setupForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  const response = await fetch("/api/auth/setup", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      password: setupPassword.value,
      confirmPassword: setupConfirmPassword.value,
    }),
  });

  const payload = await response.json();

  if (!response.ok) {
    authStatus.textContent = payload.message || "ตั้งรหัสผ่านไม่สำเร็จ";
    return;
  }

  window.location.href = redirectUrl;
});

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  const response = await fetch("/api/auth/login", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      password: loginPassword.value,
    }),
  });

  const payload = await response.json();

  if (!response.ok) {
    authStatus.textContent = payload.message || "เข้าสู่ระบบไม่สำเร็จ";
    return;
  }

  window.location.href = redirectUrl;
});

async function boot() {
  const response = await fetch("/api/auth/status");
  const payload = await response.json();

  if (payload.authenticated) {
    window.location.href = redirectUrl;
    return;
  }

  if (payload.requiresSetup) {
    authTitle.textContent = "ตั้งรหัสผ่านก่อนเข้าแอป";
    authDescription.textContent =
      "นี่คือการตั้งค่าครั้งแรกของแอป เมื่อบันทึกแล้วทุกคนต้องกรอกรหัสผ่านก่อนเข้าหน้าติดตามครอบครัว";
    setupForm.hidden = false;
    authStatus.textContent = "แนะนำให้ใช้รหัสผ่านที่เดายากพอสมควร";
    return;
  }

  authTitle.textContent = "กรอกรหัสผ่านเพื่อเข้าแอป";
  authDescription.textContent =
    "หากไม่ได้รับสิทธิ์เข้าถึง กรุณาติดต่อผู้ดูแลครอบครัวเพื่อขอรหัสผ่าน";
  loginForm.hidden = false;
}

function buildRedirectUrl() {
  const query = window.location.search || "";
  return `/app${query}`;
}
