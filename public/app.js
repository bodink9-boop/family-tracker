const socket = io();
const params = new URLSearchParams(window.location.search);

const shareForm = document.querySelector("#share-form");
const roomIdInput = document.querySelector("#room-id");
const memberNameInput = document.querySelector("#member-name");
const memberColorInput = document.querySelector("#member-color");
const shareStatus = document.querySelector("#share-status");
const shareHelp = document.querySelector("#share-help");
const stopSharingButton = document.querySelector("#stop-sharing");
const sosButton = document.querySelector("#toggle-sos");
const memberList = document.querySelector("#member-list");
const memberCount = document.querySelector("#member-count");
const activeRoomLabel = document.querySelector("#active-room-label");
const copyShareLinkButton = document.querySelector("#copy-share-link");
const installAppButton = document.querySelector("#install-app");
const installStatus = document.querySelector("#install-status");
const logoutAppButton = document.querySelector("#logout-app");
const inviteQrCanvas = document.querySelector("#invite-qr");
const inviteLinkText = document.querySelector("#invite-link-text");
const copyInviteLinkButton = document.querySelector("#copy-invite-link");

const STORAGE_KEY = "family-tracker-preferences";
const defaultPreferences = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");

const state = {
  roomId: params.get("room") || defaultPreferences.roomId || "family-home",
  memberName: params.get("member") || defaultPreferences.memberName || "",
  memberColor: defaultPreferences.memberColor || "#ff6b57",
  memberId: defaultPreferences.memberId || crypto.randomUUID(),
  watchId: null,
  isSOS: false,
  members: [],
  markers: new Map(),
  installPromptEvent: null,
  inviteLink: "",
  roomPollTimer: null,
};

const map = L.map("map", {
  zoomControl: true,
}).setView([13.7563, 100.5018], 6);

L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: "&copy; OpenStreetMap contributors",
}).addTo(map);

roomIdInput.value = state.roomId;
memberNameInput.value = state.memberName;
memberColorInput.value = state.memberColor;
activeRoomLabel.textContent = state.roomId;
renderInviteTools();

roomIdInput.addEventListener("input", () => {
  renderInviteTools();
});

socket.emit("room:join", { roomId: state.roomId });
registerAppShell();
updateInstallHint();
refreshRoomState();
startRoomPolling();

shareForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  if (!navigator.geolocation) {
    updateStatus("อุปกรณ์นี้ไม่รองรับการแชร์พิกัด");
    updateShareHelp("ลองเปิดผ่านมือถือหรือเบราว์เซอร์ที่รองรับการระบุตำแหน่ง");
    return;
  }

  state.roomId = roomIdInput.value.trim().toLowerCase() || "family-home";
  state.memberName = memberNameInput.value.trim() || "สมาชิกในครอบครัว";
  state.memberColor = memberColorInput.value;

  persistPreferences();
  connectToRoom();
  renderInviteTools();
  updateStatus("กำลังขอสิทธิ์เข้าถึงตำแหน่ง...");
  updateShareHelp("ถ้ามีหน้าต่างถามสิทธิ์ กรุณากดอนุญาตให้เข้าถึงตำแหน่ง");

  if (state.watchId !== null) {
    navigator.geolocation.clearWatch(state.watchId);
  }

  state.watchId = navigator.geolocation.watchPosition(
    async (position) => {
      const battery = await getBatteryLevel();
      const payload = {
        roomId: state.roomId,
        memberId: state.memberId,
        name: state.memberName,
        color: state.memberColor,
        lat: position.coords.latitude,
        lng: position.coords.longitude,
        accuracy: Math.round(position.coords.accuracy),
        battery,
      };

      await publishLocation(payload);
      updateStatus("กำลังแชร์พิกัดแบบสด");
      updateShareHelp("หากย้ายที่ ระบบจะอัปเดตตำแหน่งล่าสุดให้อัตโนมัติ");
    },
    (error) => {
      handleGeolocationError(error);
    },
    {
      enableHighAccuracy: true,
      maximumAge: 5000,
      timeout: 12000,
    },
  );
});

stopSharingButton.addEventListener("click", () => {
  if (state.watchId !== null) {
    navigator.geolocation.clearWatch(state.watchId);
    state.watchId = null;
  }

  socket.emit("sharing:stop", {
    roomId: state.roomId,
    memberId: state.memberId,
  });
  stopSharingFallback();

  updateStatus("หยุดแชร์พิกัดแล้ว");
  updateShareHelp("หากต้องการกลับมาแชร์อีกครั้ง ให้กดเริ่มแชร์พิกัดใหม่");
});

sosButton.addEventListener("click", async () => {
  state.isSOS = !state.isSOS;
  socket.emit("sos:update", {
    roomId: state.roomId,
    memberId: state.memberId,
    isSOS: state.isSOS,
  });
  await updateSosFallback();

  sosButton.textContent = state.isSOS ? "ปิดสัญญาณ SOS" : "เปิดสัญญาณ SOS";
  updateStatus(state.isSOS ? "เปิดสัญญาณ SOS แล้ว" : "ปิดสัญญาณ SOS แล้ว");
});

copyShareLinkButton.addEventListener("click", async () => {
  await navigator.clipboard.writeText(getInviteUrl());
  copyShareLinkButton.textContent = "คัดลอกลิงก์แล้ว";

  setTimeout(() => {
    copyShareLinkButton.textContent = "คัดลอกลิงก์แชร์ห้องนี้";
  }, 1800);
});

copyInviteLinkButton.addEventListener("click", async () => {
  const inviteUrl = getInviteUrl();
  await navigator.clipboard.writeText(inviteUrl);
  copyInviteLinkButton.textContent = "คัดลอกลิงก์เชิญแล้ว";

  setTimeout(() => {
    copyInviteLinkButton.textContent = "คัดลอกลิงก์เชิญสมาชิก";
  }, 1800);
});

installAppButton.addEventListener("click", async () => {
  if (!state.installPromptEvent) {
    updateInstallHint();
    return;
  }

  state.installPromptEvent.prompt();
  const result = await state.installPromptEvent.userChoice;
  state.installPromptEvent = null;
  installAppButton.hidden = true;

  if (result.outcome === "accepted") {
    installStatus.textContent = "ติดตั้งแอปเรียบร้อยแล้ว";
  } else {
    installStatus.textContent = "ยกเลิกการติดตั้งแอปไว้ก่อน";
  }
});

window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  state.installPromptEvent = event;
  installAppButton.hidden = false;
  installStatus.textContent = "พร้อมติดตั้งแล้ว กดปุ่มติดตั้งแอปบนมือถือได้เลย";
});

window.addEventListener("appinstalled", () => {
  state.installPromptEvent = null;
  installAppButton.hidden = true;
  installStatus.textContent = "แอปถูกติดตั้งลงเครื่องเรียบร้อยแล้ว";
});

logoutAppButton.addEventListener("click", async () => {
  await fetch("/api/auth/logout", {
    method: "POST",
  });
  window.location.href = "/";
});

socket.on("room:state", (payload) => {
  applyRoomState(payload);
});

socket.on("connect", () => {
  socket.emit("room:join", { roomId: state.roomId });
  refreshRoomState();
});

socket.on("connect_error", () => {
  updateShareHelp("การเชื่อมต่อสดมีปัญหา ระบบจะดึงข้อมูลห้องซ้ำให้อัตโนมัติ");
});

socket.on("disconnect", () => {
  updateShareHelp("การเชื่อมต่อสดหลุดชั่วคราว ระบบจะคอยรีเฟรชข้อมูลห้องให้เอง");
});

function connectToRoom() {
  socket.emit("room:join", { roomId: state.roomId });
  activeRoomLabel.textContent = state.roomId;
  renderInviteTools();
  refreshRoomState();
}

function applyRoomState(payload) {
  state.members = payload.members || [];
  activeRoomLabel.textContent = payload.roomId;
  roomIdInput.value = payload.roomId;
  renderInviteTools();
  renderMembers();
  renderMarkers();
}

function renderMembers() {
  memberCount.textContent = `${state.members.length} คน`;

  if (!state.members.length) {
    memberList.innerHTML = `
      <div class="empty-state">
        ยังไม่มีสมาชิกกำลังแชร์พิกัดในห้องนี้
      </div>
    `;
    return;
  }

  memberList.innerHTML = state.members
    .map((member) => {
      const tagClass = member.isSOS ? "sos" : member.isSharing ? "live" : "offline";
      const tagLabel = member.isSOS ? "SOS" : member.isSharing ? "กำลังแชร์" : "ออฟไลน์";
      const mapLink =
        typeof member.lat === "number" && typeof member.lng === "number"
          ? `https://www.google.com/maps?q=${member.lat},${member.lng}`
          : null;

      return `
        <article class="member-card">
          <div class="member-head">
            <div class="member-name">
              <span class="member-dot" style="background:${member.color}"></span>
              <span>${member.name}</span>
            </div>
            <span class="tag ${tagClass}">${tagLabel}</span>
          </div>
          <p class="member-meta">อัปเดตล่าสุด: ${formatDate(member.updatedAt)}</p>
          <p class="member-meta">ความแม่นยำ: ${member.accuracy ? `${member.accuracy} เมตร` : "-"}</p>
          <p class="member-meta">แบตเตอรี่: ${member.battery ?? "-"}%</p>
          ${
            mapLink
              ? `<a href="${mapLink}" target="_blank" rel="noreferrer">เปิดใน Google Maps</a>`
              : `<span class="member-meta">ยังไม่มีพิกัดล่าสุด</span>`
          }
        </article>
      `;
    })
    .join("");
}

function renderMarkers() {
  const visibleBounds = [];

  state.members.forEach((member) => {
    if (typeof member.lat !== "number" || typeof member.lng !== "number") {
      return;
    }

    visibleBounds.push([member.lat, member.lng]);

    let marker = state.markers.get(member.memberId);
    const markerHtml = `
      <div style="
        width:18px;
        height:18px;
        border-radius:999px;
        background:${member.color};
        border:3px solid white;
        box-shadow:0 8px 20px rgba(0,0,0,0.18);
      "></div>
    `;

    if (!marker) {
      marker = L.marker([member.lat, member.lng], {
        icon: L.divIcon({
          className: "custom-pin",
          html: markerHtml,
          iconSize: [18, 18],
          iconAnchor: [9, 9],
        }),
      }).addTo(map);
      state.markers.set(member.memberId, marker);
    } else {
      marker.setLatLng([member.lat, member.lng]);
      marker.setIcon(
        L.divIcon({
          className: "custom-pin",
          html: markerHtml,
          iconSize: [18, 18],
          iconAnchor: [9, 9],
        }),
      );
    }

    marker.bindPopup(`
      <strong>${member.name}</strong><br />
      ${member.isSOS ? "SOS เปิดอยู่<br />" : ""}
      อัปเดตล่าสุด ${formatDate(member.updatedAt)}
    `);
  });

  state.markers.forEach((marker, memberId) => {
    if (!state.members.find((member) => member.memberId === memberId)) {
      map.removeLayer(marker);
      state.markers.delete(memberId);
    }
  });

  if (visibleBounds.length === 1) {
    map.setView(visibleBounds[0], 15);
  } else if (visibleBounds.length > 1) {
    map.fitBounds(visibleBounds, { padding: [50, 50] });
  }
}

function updateStatus(text) {
  shareStatus.textContent = text;
}

function updateShareHelp(text) {
  shareHelp.textContent = text;
}

async function publishLocation(payload) {
  if (socket.connected) {
    socket.emit("location:update", payload);
  }

  try {
    const response = await fetch(`/api/rooms/${encodeURIComponent(payload.roomId)}/location`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new Error("location-sync-failed");
    }

    const result = await response.json();
    if (result.room) {
      applyRoomState(result.room);
    }
  } catch (error) {
    updateShareHelp("ส่งพิกัดขึ้นเซิร์ฟเวอร์ยังไม่ครบ ระบบจะลองดึงข้อมูลห้องซ้ำอีกครั้ง");
  }
}

async function stopSharingFallback() {
  try {
    const response = await fetch(`/api/rooms/${encodeURIComponent(state.roomId)}/sharing-stop`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        memberId: state.memberId,
      }),
    });

    if (!response.ok) {
      return;
    }

    const result = await response.json();
    if (result.room) {
      applyRoomState(result.room);
    }
  } catch (error) {
    // Ignore fallback failures here because the user can still retry sharing.
  }
}

async function updateSosFallback() {
  try {
    const response = await fetch(`/api/rooms/${encodeURIComponent(state.roomId)}/sos`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        memberId: state.memberId,
        isSOS: state.isSOS,
      }),
    });

    if (!response.ok) {
      return;
    }

    const result = await response.json();
    if (result.room) {
      applyRoomState(result.room);
    }
  } catch (error) {
    // Ignore fallback failures here because the realtime socket may still succeed.
  }
}

async function refreshRoomState() {
  try {
    const response = await fetch(`/api/rooms/${encodeURIComponent(state.roomId)}`, {
      cache: "no-store",
    });

    if (!response.ok) {
      return;
    }

    const room = await response.json();
    applyRoomState(room);
  } catch (error) {
    // Ignore transient refresh issues and let the next poll retry.
  }
}

function startRoomPolling() {
  if (state.roomPollTimer !== null) {
    window.clearInterval(state.roomPollTimer);
  }

  state.roomPollTimer = window.setInterval(() => {
    refreshRoomState();
  }, 8000);
}

function handleGeolocationError(error) {
  if (error.code === 1) {
    updateStatus("ยังแชร์พิกัดไม่ได้ เพราะมีการกดไม่อนุญาตตำแหน่ง");
    updateShareHelp(
      "ให้กดไอคอนรูปแม่กุญแจหรือการตั้งค่าเว็บไซต์ แล้วเปิดสิทธิ์ Location เป็น Allow จากนั้นกดเริ่มแชร์อีกครั้ง",
    );
    return;
  }

  if (error.code === 2) {
    updateStatus("ยังหา位置ปัจจุบันไม่เจอ");
    updateShareHelp("ลองเปิด GPS หรือ Location Services บนมือถือ แล้วกดเริ่มแชร์อีกครั้ง");
    return;
  }

  if (error.code === 3) {
    updateStatus("ใช้เวลาหาตำแหน่งนานเกินไป");
    updateShareHelp("ลองย้ายไปบริเวณที่สัญญาณดีขึ้น หรือเปิดอินเทอร์เน็ตและ GPS แล้วลองใหม่");
    return;
  }

  updateStatus(`แชร์พิกัดไม่สำเร็จ: ${error.message}`);
  updateShareHelp("ลองตรวจสอบสิทธิ์ตำแหน่งของเบราว์เซอร์แล้วกดเริ่มแชร์ใหม่อีกครั้ง");
}

async function registerAppShell() {
  if (!("serviceWorker" in navigator)) {
    installStatus.textContent = "เบราว์เซอร์นี้ยังไม่รองรับการติดตั้งแอป";
    return;
  }

  try {
    await navigator.serviceWorker.register("/service-worker.js");
  } catch (error) {
    installStatus.textContent = "ลงทะเบียนแอปสำหรับการติดตั้งไม่สำเร็จ";
    return;
  }
}

function renderInviteTools() {
  state.roomId = roomIdInput.value.trim().toLowerCase() || state.roomId || "family-home";
  state.inviteLink = getInviteUrl();
  inviteLinkText.textContent = state.inviteLink;
  inviteQrCanvas.src = `/api/invite-qr?room=${encodeURIComponent(state.roomId)}&t=${Date.now()}`;
  inviteQrCanvas.onerror = () => {
    inviteLinkText.textContent = "สร้าง QR Code ไม่สำเร็จ ลองคัดลอกลิงก์แทน";
  };
}

function persistPreferences() {
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      roomId: state.roomId,
      memberName: state.memberName,
      memberColor: state.memberColor,
      memberId: state.memberId,
    }),
  );
}

async function getBatteryLevel() {
  if (!navigator.getBattery) {
    return null;
  }

  try {
    const battery = await navigator.getBattery();
    return Math.round(battery.level * 100);
  } catch (error) {
    return null;
  }
}

function formatDate(isoString) {
  if (!isoString) {
    return "-";
  }

  return new Intl.DateTimeFormat("th-TH", {
    dateStyle: "short",
    timeStyle: "medium",
  }).format(new Date(isoString));
}

function updateInstallHint() {
  const isStandalone =
    window.matchMedia("(display-mode: standalone)").matches ||
    window.navigator.standalone === true;

  if (isStandalone) {
    installStatus.textContent = "แอปนี้กำลังเปิดในโหมดติดตั้งบนมือถือแล้ว";
    installAppButton.hidden = true;
    return;
  }

  if (!window.isSecureContext && location.hostname !== "localhost") {
    installStatus.textContent =
      "การติดตั้งและแชร์พิกัดบนมือถือจริงควรเปิดผ่าน HTTPS ก่อน";
    installAppButton.hidden = true;
    return;
  }

  const userAgent = navigator.userAgent.toLowerCase();

  if (userAgent.includes("iphone") || userAgent.includes("ipad")) {
    installStatus.textContent =
      "บน iPhone ให้กด Share แล้วเลือก Add to Home Screen เพื่อใช้งานแบบแอป";
    installAppButton.hidden = true;
    return;
  }

  installStatus.textContent =
    "หากยังไม่เห็นปุ่มติดตั้ง ให้เปิดผ่าน Chrome หรือ Edge บนมือถือ";
}

function getInviteUrl() {
  const roomId = roomIdInput.value.trim().toLowerCase() || state.roomId || "family-home";
  const inviteUrl = new URL("/", window.location.origin);
  inviteUrl.searchParams.set("room", roomId);
  inviteUrl.searchParams.set("join", "qr");
  return inviteUrl.toString();
}
