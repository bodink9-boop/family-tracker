const crypto = require("crypto");
const http = require("http");
const fs = require("fs");
const path = require("path");
const express = require("express");
const session = require("express-session");
const QRCode = require("qrcode");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const IS_PRODUCTION = process.env.NODE_ENV === "production";
const rooms = new Map();
const DATA_DIR = path.join(__dirname, "data");
const AUTH_FILE = path.join(DATA_DIR, "auth.json");
const SESSION_SECRET =
  process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");

fs.mkdirSync(DATA_DIR, { recursive: true });

app.set("trust proxy", 1);

const sessionMiddleware = session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: IS_PRODUCTION,
    maxAge: 1000 * 60 * 60 * 24 * 7,
  },
});

app.use(express.json());
app.use(sessionMiddleware);

function normalizeRoomId(roomId = "") {
  return roomId.trim().toLowerCase() || "family-home";
}

function getEnvironmentAuthConfig() {
  if (process.env.AUTH_PASSWORD_HASH) {
    return {
      source: "env-hash",
      passwordHash: process.env.AUTH_PASSWORD_HASH,
    };
  }

  if (process.env.AUTH_PASSWORD) {
    return {
      source: "env-plain",
      password: process.env.AUTH_PASSWORD,
    };
  }

  return null;
}

function readAuthConfig() {
  const environmentAuth = getEnvironmentAuthConfig();

  if (environmentAuth) {
    return environmentAuth;
  }

  if (!fs.existsSync(AUTH_FILE)) {
    return null;
  }

  return JSON.parse(fs.readFileSync(AUTH_FILE, "utf8"));
}

function hasPasswordConfigured() {
  const config = readAuthConfig();
  return Boolean(config?.passwordHash || config?.password);
}

function createPasswordHash(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, storedHash) {
  if (!storedHash || !password) {
    return false;
  }

  const [salt, originalHash] = storedHash.split(":");

  if (!salt || !originalHash) {
    return false;
  }

  const candidateHash = crypto.scryptSync(password, salt, 64).toString("hex");
  return crypto.timingSafeEqual(
    Buffer.from(originalHash, "hex"),
    Buffer.from(candidateHash, "hex"),
  );
}

function markAuthenticated(req) {
  req.session.authenticated = true;
}

function isAuthenticated(req) {
  return req.session?.authenticated === true;
}

function requireAuth(req, res, next) {
  if (isAuthenticated(req)) {
    return next();
  }

  return res.redirect("/");
}

function getRoom(roomId) {
  const normalizedRoomId = normalizeRoomId(roomId);

  if (!rooms.has(normalizedRoomId)) {
    rooms.set(normalizedRoomId, {
      members: new Map(),
    });
  }

  return rooms.get(normalizedRoomId);
}

function serializeRoom(roomId) {
  const room = getRoom(roomId);
  return {
    roomId: normalizeRoomId(roomId),
    members: Array.from(room.members.values()).sort((left, right) =>
      left.name.localeCompare(right.name, "th"),
    ),
  };
}

function upsertMember(payload) {
  const roomId = normalizeRoomId(payload.roomId);
  const room = getRoom(roomId);
  const memberId = payload.memberId;

  if (!memberId) {
    return null;
  }

  const nextMember = {
    memberId,
    name: payload.name || "สมาชิกในครอบครัว",
    color: payload.color || "#ff6b57",
    lat: payload.lat,
    lng: payload.lng,
    accuracy: payload.accuracy ?? null,
    battery: payload.battery ?? null,
    isSharing: Boolean(payload.isSharing),
    isSOS: Boolean(payload.isSOS),
    updatedAt: new Date().toISOString(),
    socketId: payload.socketId || null,
  };

  room.members.set(memberId, nextMember);
  return { roomId, member: nextMember };
}

function broadcastRoom(roomId) {
  io.to(normalizeRoomId(roomId)).emit("room:state", serializeRoom(roomId));
}

app.use(
  express.static("public", {
    index: false,
  }),
);

app.get("/api/auth/status", (req, res) => {
  res.json({
    requiresSetup: !hasPasswordConfigured(),
    authenticated: isAuthenticated(req),
    authSource: readAuthConfig()?.source || "file",
  });
});

app.post("/api/auth/setup", (req, res) => {
  const { password, confirmPassword } = req.body || {};

  if (getEnvironmentAuthConfig()) {
    return res.status(409).json({
      message: "This deployment manages the app password through environment variables.",
    });
  }

  if (hasPasswordConfigured()) {
    return res.status(409).json({ message: "มีรหัสผ่านตั้งไว้แล้ว" });
  }

  if (!password || password.length < 6) {
    return res
      .status(400)
      .json({ message: "รหัสผ่านต้องยาวอย่างน้อย 6 ตัวอักษร" });
  }

  if (password !== confirmPassword) {
    return res.status(400).json({ message: "ยืนยันรหัสผ่านไม่ตรงกัน" });
  }

  fs.writeFileSync(
    AUTH_FILE,
    JSON.stringify(
      {
        passwordHash: createPasswordHash(password),
        createdAt: new Date().toISOString(),
      },
      null,
      2,
    ),
    "utf8",
  );

  markAuthenticated(req);
  return res.json({ ok: true });
});

app.post("/api/auth/login", (req, res) => {
  const { password } = req.body || {};
  const config = readAuthConfig();

  if (!config) {
    return res.status(400).json({ message: "ยังไม่ได้ตั้งรหัสผ่าน" });
  }

  const isValidPassword =
    config.password === password ||
    verifyPassword(password, config.passwordHash);

  if (!isValidPassword) {
    return res.status(401).json({ message: "รหัสผ่านไม่ถูกต้อง" });
  }

  markAuthenticated(req);
  return res.json({ ok: true });
});

app.post("/api/auth/logout", (req, res) => {
  req.session.destroy(() => {
    res.clearCookie("connect.sid");
    res.json({ ok: true });
  });
});

app.get("/", (req, res) => {
  if (isAuthenticated(req)) {
    const query = req.originalUrl.includes("?") ? req.originalUrl.slice(req.originalUrl.indexOf("?")) : "";
    return res.redirect(`/app${query}`);
  }

  return res.sendFile(path.join(__dirname, "public", "auth.html"));
});

app.get("/app", requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "app.html"));
});

app.get("/api/rooms/:roomId", requireAuth, (req, res) => {
  res.json(serializeRoom(req.params.roomId));
});

app.post("/api/rooms/:roomId/location", requireAuth, (req, res) => {
  const result = upsertMember({
    ...req.body,
    roomId: req.params.roomId,
    isSharing: true,
  });

  if (!result) {
    return res.status(400).json({ message: "Missing memberId" });
  }

  broadcastRoom(result.roomId);
  return res.json({
    ok: true,
    room: serializeRoom(result.roomId),
  });
});

app.post("/api/rooms/:roomId/sos", requireAuth, (req, res) => {
  const roomId = normalizeRoomId(req.params.roomId);
  const room = getRoom(roomId);
  const member = room.members.get(req.body?.memberId);

  if (!member) {
    return res.status(404).json({ message: "Member not found" });
  }

  member.isSOS = Boolean(req.body?.isSOS);
  member.updatedAt = new Date().toISOString();
  room.members.set(member.memberId, member);
  broadcastRoom(roomId);

  return res.json({
    ok: true,
    room: serializeRoom(roomId),
  });
});

app.post("/api/rooms/:roomId/sharing-stop", requireAuth, (req, res) => {
  const roomId = normalizeRoomId(req.params.roomId);
  const room = getRoom(roomId);
  const member = room.members.get(req.body?.memberId);

  if (!member) {
    return res.status(404).json({ message: "Member not found" });
  }

  member.isSharing = false;
  member.updatedAt = new Date().toISOString();
  room.members.set(member.memberId, member);
  broadcastRoom(roomId);

  return res.json({
    ok: true,
    room: serializeRoom(roomId),
  });
});

app.get("/api/invite-qr", requireAuth, async (req, res) => {
  const roomId = normalizeRoomId(req.query.room);
  const origin = `${req.protocol}://${req.get("host")}`;
  const inviteUrl = new URL("/", origin);
  inviteUrl.searchParams.set("room", roomId);
  inviteUrl.searchParams.set("join", "qr");

  try {
    const svg = await QRCode.toString(inviteUrl.toString(), {
      type: "svg",
      width: 220,
      margin: 1,
      color: {
        dark: "#23180f",
        light: "#fffaf2",
      },
    });

    res.setHeader("Content-Type", "image/svg+xml");
    res.send(svg);
  } catch (error) {
    res.status(500).json({ message: "สร้าง QR Code ไม่สำเร็จ" });
  }
});

app.get("/health", (_req, res) => {
  res.status(200).json({
    ok: true,
    timestamp: new Date().toISOString(),
    rooms: rooms.size,
  });
});

io.use((socket, next) => {
  sessionMiddleware(socket.request, {}, next);
});

io.use((socket, next) => {
  if (socket.request.session?.authenticated) {
    return next();
  }

  return next(new Error("unauthorized"));
});

io.on("connection", (socket) => {
  socket.on("room:join", ({ roomId }) => {
    const normalizedRoomId = normalizeRoomId(roomId);
    socket.join(normalizedRoomId);
    socket.emit("room:state", serializeRoom(normalizedRoomId));
  });

  socket.on("location:update", (payload) => {
    const result = upsertMember({
      ...payload,
      socketId: socket.id,
      isSharing: true,
    });

    if (!result) {
      return;
    }

    socket.join(result.roomId);
    broadcastRoom(result.roomId);
  });

  socket.on("sos:update", (payload) => {
    const roomId = normalizeRoomId(payload.roomId);
    const room = getRoom(roomId);
    const member = room.members.get(payload.memberId);

    if (!member) {
      return;
    }

    member.isSOS = Boolean(payload.isSOS);
    member.updatedAt = new Date().toISOString();
    room.members.set(payload.memberId, member);
    broadcastRoom(roomId);
  });

  socket.on("sharing:stop", ({ roomId, memberId }) => {
    const normalizedRoomId = normalizeRoomId(roomId);
    const room = getRoom(normalizedRoomId);
    const member = room.members.get(memberId);

    if (!member) {
      return;
    }

    member.isSharing = false;
    member.updatedAt = new Date().toISOString();
    room.members.set(memberId, member);
    broadcastRoom(normalizedRoomId);
  });

  socket.on("disconnect", () => {
    rooms.forEach((room, roomId) => {
      let changed = false;

      room.members.forEach((member, memberId) => {
        if (member.socketId === socket.id) {
          room.members.set(memberId, {
            ...member,
            isSharing: false,
            updatedAt: new Date().toISOString(),
          });
          changed = true;
        }
      });

      if (changed) {
        broadcastRoom(roomId);
      }
    });
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Family tracker is running on http://localhost:${PORT}`);
});
