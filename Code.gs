// =====================================================================
//  ระบบลงเวลา สกป.ชุมพลบุรี  —  Apps Script เวอร์ชัน 3 (มีระบบ login พนักงาน)
// ---------------------------------------------------------------------
//  ตั้งค่าที่ Project Settings > Script properties
//    ADMIN_PIN            (จำเป็น) PIN ผู้ดูแล อย่างน้อย 6 หลัก  ถ้าไม่ตั้ง เมนูผู้ดูแลจะใช้ไม่ได้
//    ค่าอื่นเปลี่ยนได้จากหน้าเว็บ (ตั้งค่าระบบ) หรือใส่เองที่นี่:
//    COOP_LAT, COOP_LNG, GEO_RADIUS_M, GEO_MAX_ACCURACY_M, GEO_ENFORCED, PHOTO_REQUIRED,
//    WORK_START, WORK_END, AFTERNOON_START, SCAN_OPEN, SCAN_CLOSE, CHECKOUT_CLOSE, OUTING_START, OUTING_END
//  วันหยุดนักขัตฤกษ์: ใส่วันที่ (เช่น 2026-12-07) ในคอลัมน์ A ของชีต "วันหยุด" (ระบบสร้างให้เอง)
// =====================================================================

const APP_VERSION = 4;
const TZ = 'Asia/Bangkok';
const SHEET_EMP = 'รายชื่อพนักงาน';
const SHEET_LOG = 'ประวัติลงเวลา';
const SHEET_OUT = 'บันทึกออกนอกพื้นที่';
const SHEET_HOL = 'วันหยุด';
const SHEET_AUDIT = 'บันทึกการแก้ไข';
const PHOTO_FOLDER = 'ภาพยืนยันลงเวลา_สกป_ชุมพลบุรี';

const DEFAULTS = {
  COOP_LAT: '15.349312',
  COOP_LNG: '103.412188',
  GEO_RADIUS_M: '120',
  GEO_MAX_ACCURACY_M: '100',
  GEO_ENFORCED: 'true',
  PHOTO_REQUIRED: 'true',
  WORK_START: '08:30',
  WORK_END: '16:30',
  AFTERNOON_START: '13:00', // เวลาเริ่มงานช่วงบ่าย ใช้กับ "ลาครึ่งวันเช้า" (เข้าไม่เกินเวลานี้ไม่นับสาย)
  SCAN_OPEN: '05:30',
  SCAN_CLOSE: '22:00',      // หลังเวลานี้สแกน "เข้า" ไม่ได้
  CHECKOUT_CLOSE: '23:59',  // สแกน "ออก" ได้ถึงเวลานี้ (สำหรับคนอยู่ OT ดึก)
  OUTING_START: '08:00',
  OUTING_END: '16:30'
};
const CONFIG_KEYS = Object.keys(DEFAULTS);
const MIN_CHECKOUT_GAP_MINS = 30;
const MIN_OUTING_RETURN_MINS = 2;
const MAX_PHOTO_CHARS = 3000000;      // ประมาณ 2.2 MB
const MIN_PASSWORD_LEN = 6;
const MIN_PIN_LEN = 6;
const MAX_FAILS = 5;
const LOCKOUT_SEC = 15 * 60;
const DEVICE_SELF_MOVE_DAYS = 7;   // พนักงานย้ายมือถือ/เบราว์เซอร์เองได้ 1 ครั้งต่อ 7 วัน (ใช้รหัสผ่าน)

// คอลัมน์ (เริ่มที่ 1)
const EMP = { ID: 1, NAME: 2, DEPT: 3, DEVICE: 5, PWHASH: 6, SALT: 7, TOKEN: 8, WIDTH: 8 };
const EMP_HEADERS = ['รหัสพนักงาน', 'ชื่อ-สกุล', 'แผนก', '', 'รหัสเครื่องที่ผูก', 'รหัสผ่าน (เข้ารหัสแล้ว)', 'salt', 'token (เข้ารหัสแล้ว)'];
const LOG = { DATE: 1, EMP: 2, NAME: 3, DEPT: 4, IN: 5, IN_ST: 6, OUT: 7, OUT_ST: 8, DIST: 9, COORDS: 10, PHOTO_IN: 11, PHOTO_OUT: 12, NOTE: 13, REASON: 14, REVIEW: 15, WIDTH: 15 };
const LOG_HEADERS = ['วันที่', 'รหัสพนักงาน', 'ชื่อ-สกุล', 'แผนก', 'เวลาเข้า', 'สถานะเข้า', 'เวลาออก', 'สถานะออก', 'ระยะ (ม.)', 'พิกัด', 'ภาพตอนเข้า', 'ภาพตอนออก', 'หมายเหตุ', 'เหตุที่เข้าหลังเวลา', 'ผลตรวจผู้ดูแล'];

// เหตุที่เข้าหลังเวลา (พนักงานเลือกเองตอนสแกนครั้งแรกหลังเวลาเข้างาน)
const REASON = { LATE: 'มาสาย', HALFDAY: 'ลาครึ่งวันเช้า', OFFICIAL: 'ไปราชการ/งานนอกสถานที่', FORGOT: 'ลืมสแกนเข้า' };
const REASON_CODES = { late: REASON.LATE, halfday: REASON.HALFDAY, official: REASON.OFFICIAL, forgot_in: REASON.FORGOT, forgot_out: REASON.FORGOT };
const REVIEW = { PENDING: 'รอตรวจ', OK: 'อนุมัติ', NO: 'ไม่อนุมัติ' };
const OUT = { DATE: 1, EMP: 2, NAME: 3, DEPT: 4, CAT: 5, REASON: 6, OUT: 7, RET: 8, DUR: 9, STATUS: 10, PHOTO_OUT: 11, PHOTO_RET: 12, WIDTH: 12 };
const OUT_HEADERS = ['วันที่', 'รหัสพนักงาน', 'ชื่อ-สกุล', 'แผนก', 'ประเภท', 'รายละเอียด/ภารกิจ', 'เวลาออก', 'เวลากลับ', 'ระยะเวลา (นาที)', 'สถานะ', 'ภาพตอนออก', 'ภาพตอนกลับ'];

// ข้อผิดพลาดที่ตั้งใจส่งให้ผู้ใช้เห็น
function UserError(message, extra) { this.message = message; this.extra = extra || {}; }
function fail(message, extra) { throw new UserError(message, extra); }

// =====================================================================
//  ทางเข้า
// =====================================================================
function doGet() {
  // สาธารณะ: ส่งเฉพาะค่าตั้งค่า ไม่มีข้อมูลพนักงาน
  return jsonOut({ ok: true, version: APP_VERSION, config: publicConfig() });
}

function doPost(e) {
  let data;
  try {
    data = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return jsonOut({ ok: false, message: 'ข้อมูลที่ส่งมาไม่ถูกต้อง' });
  }
  try {
    const handler = HANDLERS[String(data.type || '')];
    if (!handler) {
      return jsonOut({ ok: false, outdated: true, message: 'หน้าเว็บเป็นเวอร์ชันเก่า กรุณาปิดแล้วเปิดหน้าเว็บใหม่' });
    }
    return jsonOut(handler(data));
  } catch (err) {
    if (err instanceof UserError) return jsonOut(Object.assign({ ok: false, message: err.message }, err.extra));
    const code = 'E-' + Utilities.formatDate(new Date(), TZ, 'HHmmss');
    console.error(code + ' ' + (err && err.stack ? err.stack : err));
    if (/lock|timeout|ล็อก/i.test(String(err))) {
      return jsonOut({ ok: false, retry: true, message: 'มีคนใช้งานพร้อมกันจำนวนมาก กรุณากดลองใหม่อีกครั้ง' });
    }
    return jsonOut({ ok: false, retry: true, message: 'ระบบขัดข้องชั่วคราว กรุณาลองใหม่ (รหัส ' + code + ')' });
  }
}

const HANDLERS = {
  login: handleLogin,
  logout: handleLogout,
  change_password: handleChangePassword,
  me: handleMe,
  scan: handleScan,
  outing: handleOuting,
  admin_verify: (d) => { requireAdmin(d); return { ok: true }; },
  admin_change_pin: handleAdminChangePin,
  admin_data: handleAdminData,
  admin_photo: handleAdminPhoto,
  admin_record: handleAdminRecord,
  admin_review: handleAdminReview,
  admin_reset_device: handleAdminResetDevice,
  admin_save_employee: handleAdminSaveEmployee,
  admin_delete_employee: handleAdminDeleteEmployee,
  admin_delete_log: handleAdminDeleteLog,
  admin_set_config: handleAdminSetConfig
};

// =====================================================================
//  ค่าตั้งค่า
// =====================================================================
function getConfig() {
  const props = PropertiesService.getScriptProperties();
  const c = {};
  CONFIG_KEYS.forEach((k) => {
    const v = props.getProperty(k);
    c[k] = (v === null || v === '') ? DEFAULTS[k] : String(v);
  });
  return {
    coopLat: Number(c.COOP_LAT),
    coopLng: Number(c.COOP_LNG),
    radiusM: Number(c.GEO_RADIUS_M) || 120,
    maxAccuracyM: Number(c.GEO_MAX_ACCURACY_M) || 100,
    geoEnforced: c.GEO_ENFORCED.toLowerCase() !== 'false',
    photoRequired: c.PHOTO_REQUIRED.toLowerCase() !== 'false',
    workStart: c.WORK_START,
    workEnd: c.WORK_END,
    afternoonStart: c.AFTERNOON_START,
    scanOpen: c.SCAN_OPEN,
    scanClose: c.SCAN_CLOSE,
    checkoutClose: c.CHECKOUT_CLOSE,
    outingStart: c.OUTING_START,
    outingEnd: c.OUTING_END,
    minCheckoutGapMins: MIN_CHECKOUT_GAP_MINS,
    minOutingReturnMins: MIN_OUTING_RETURN_MINS
  };
}
function publicConfig() { return getConfig(); }

// =====================================================================
//  ชีต
// =====================================================================
function ss() { return SpreadsheetApp.getActiveSpreadsheet(); }

function sheetWithHeaders(name, headers) {
  let sh = ss().getSheetByName(name);
  if (!sh) {
    sh = ss().insertSheet(name);
    sh.appendRow(headers);
    return sh;
  }
  // ชีตเก่าที่มีคอลัมน์ไม่พอ (เช่น ลบคอลัมน์ว่างทิ้ง) เพิ่มคอลัมน์ให้เอง กันระบบล่ม
  if (sh.getMaxColumns() < headers.length) sh.insertColumnsAfter(sh.getMaxColumns(), headers.length - sh.getMaxColumns());
  const first = sh.getRange(1, 1, 1, headers.length).getValues()[0];
  headers.forEach((h, i) => {
    if (h && !first[i]) sh.getRange(1, i + 1).setValue(h);
  });
  return sh;
}

function readRows(sh, width) {
  const last = sh.getLastRow();
  if (last < 2) return [];
  // อ่านเท่าที่ชีตมีคอลัมน์ แล้วเติมช่องว่างให้ครบ (ชีตเก่าอาจมีคอลัมน์น้อยกว่า)
  const w = Math.min(width, sh.getMaxColumns());
  return sh.getRange(2, 1, last - 1, w).getValues().map((r) => (w < width ? r.concat(new Array(width - w).fill('')) : r));
}

// เขียนเป็นข้อความเสมอ กัน Google Sheets แปลงวันที่/เวลาเอง
function writeRow(sh, rowNum, values) {
  const r = sh.getRange(rowNum, 1, 1, values.length);
  r.setNumberFormat('@');
  r.setValues([values.map((v) => (v === null || v === undefined) ? '' : String(v))]);
}
function writeCells(sh, rowNum, col, values) {
  const r = sh.getRange(rowNum, col, 1, values.length);
  r.setNumberFormat('@');
  r.setValues([values.map((v) => (v === null || v === undefined) ? '' : String(v))]);
}
function appendRowText(sh, values) { writeRow(sh, sh.getLastRow() + 1, values); }

function audit(actor, action, detail) {
  const sh = sheetWithHeaders(SHEET_AUDIT, ['วันเวลา', 'ผู้ทำ', 'การกระทำ', 'รายละเอียด']);
  appendRowText(sh, [Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm:ss'), actor, action, detail]);
}

function loadEmployees() {
  const sh = sheetWithHeaders(SHEET_EMP, EMP_HEADERS);
  return { sh, rows: readRows(sh, EMP.WIDTH) };
}
function empFromRow(r, idx) {
  return {
    row: idx + 2,
    id: normId(r[EMP.ID - 1]),
    name: String(r[EMP.NAME - 1] || '').trim(),
    dept: String(r[EMP.DEPT - 1] || '').trim(),
    deviceId: String(r[EMP.DEVICE - 1] || '').trim(),
    pwHash: String(r[EMP.PWHASH - 1] || '').trim(),
    salt: String(r[EMP.SALT - 1] || '').trim(),
    tokenHash: String(r[EMP.TOKEN - 1] || '').trim()
  };
}
function findEmp(rows, empId) {
  const id = normId(empId);
  for (let i = 0; i < rows.length; i++) {
    if (normId(rows[i][EMP.ID - 1]) === id && id) return empFromRow(rows[i], i);
  }
  return null;
}
function publicEmp(emp) { return { id: emp.id, name: emp.name, dept: emp.dept }; }

function loadHolidays() {
  const sh = sheetWithHeaders(SHEET_HOL, ['วันที่ (yyyy-MM-dd)', 'ชื่อวันหยุด']);
  return readRows(sh, 2).map((r) => ({ date: fmtDate(r[0]), name: String(r[1] || '').trim() })).filter((h) => /^\d{4}-\d{2}-\d{2}$/.test(h.date));
}

function isDayOff(dateStr, holidays) {
  const parts = dateStr.split('-').map(Number);
  const dow = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2])).getUTCDay(); // 0 = อาทิตย์
  if (dow === 0 || dow === 6) return true;
  return holidays.some((h) => h.date === dateStr);
}

// =====================================================================
//  ความปลอดภัย: hash, token, จำกัดจำนวนครั้ง
// =====================================================================
function sha256Hex(text) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, text, Utilities.Charset.UTF_8);
  return bytes.map((b) => ('0' + (b & 0xff).toString(16)).slice(-2)).join('');
}
function hashPassword(password, salt) {
  let h = salt + ':' + password;
  for (let i = 0; i < 300; i++) h = sha256Hex(salt + h);
  return h;
}
function newSecret() { return (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, ''); }

function checkLockout(key) {
  const c = CacheService.getScriptCache();
  const n = Number(c.get('fail:' + key) || 0);
  if (n >= MAX_FAILS) fail('ใส่รหัสผิดเกิน ' + MAX_FAILS + ' ครั้ง ระบบล็อกไว้ 15 นาที กรุณารอแล้วลองใหม่');
}
function recordFail(key) {
  const c = CacheService.getScriptCache();
  const n = Number(c.get('fail:' + key) || 0) + 1;
  c.put('fail:' + key, String(n), LOCKOUT_SEC);
  return MAX_FAILS - n;
}
function clearFails(key) { CacheService.getScriptCache().remove('fail:' + key); }

function requireAdmin(d) {
  const saved = String(PropertiesService.getScriptProperties().getProperty('ADMIN_PIN') || '').trim();
  if (!saved) fail('ยังไม่ได้ตั้งรหัส ADMIN_PIN ใน Apps Script (Project Settings > Script properties)');
  checkLockout('pin');
  if (String(d.pin || '').trim() !== saved) {
    const left = recordFail('pin');
    fail(left > 0 ? 'รหัส PIN ผู้ดูแลไม่ถูกต้อง (เหลือ ' + left + ' ครั้ง)' : 'ใส่ PIN ผิดเกิน ' + MAX_FAILS + ' ครั้ง ระบบล็อกไว้ 15 นาที');
  }
  clearFails('pin');
}

function validDeviceId(id) { return /^[A-Za-z0-9-]{12,80}$/.test(String(id || '')); }

// ตรวจ token + เครื่อง แล้วคืนข้อมูลพนักงาน
function requireEmployee(d) {
  const token = String(d.token || '');
  const deviceId = String(d.deviceId || '').trim();
  if (!token) fail('กรุณาเข้าสู่ระบบก่อน', { needLogin: true });
  const th = sha256Hex(token);
  const { rows } = loadEmployees();
  for (let i = 0; i < rows.length; i++) {
    const emp = empFromRow(rows[i], i);
    if (emp.tokenHash && emp.tokenHash === th) {
      if (!emp.deviceId || emp.deviceId !== deviceId) {
        fail('บัญชีนี้ใช้ได้เฉพาะมือถือที่ผูกไว้ กรุณาเข้าสู่ระบบใหม่ หรือแจ้งผู้ดูแลให้รีเซ็ตเครื่อง', { needLogin: true });
      }
      return emp;
    }
  }
  fail('หมดเวลาเข้าสู่ระบบ หรือผู้ดูแลรีเซ็ตบัญชีแล้ว กรุณาเข้าสู่ระบบใหม่', { needLogin: true });
}

// =====================================================================
//  พนักงาน: login / logout / เปลี่ยนรหัสผ่าน / ข้อมูลของฉัน
// =====================================================================
function handleLogin(d) {
  const empId = normId(d.empId);
  const password = String(d.password || '');
  const deviceId = String(d.deviceId || '').trim();
  if (!empId || !password) fail('กรุณากรอกรหัสพนักงานและรหัสผ่าน');
  if (!validDeviceId(deviceId)) fail('ไม่พบรหัสเครื่อง กรุณาโหลดหน้าเว็บใหม่');
  checkLockout('login:' + empId);

  return withLock(() => {
    const { sh, rows } = loadEmployees();
    const emp = findEmp(rows, empId);
    if (!emp) { recordFail('login:' + empId); fail('รหัสพนักงานหรือรหัสผ่านไม่ถูกต้อง'); }

    // มือถือเครื่องนี้ผูกกับคนอื่นอยู่หรือไม่
    for (let i = 0; i < rows.length; i++) {
      const other = empFromRow(rows[i], i);
      if (other.id !== emp.id && other.deviceId && other.deviceId === deviceId) {
        fail('มือถือเครื่องนี้ผูกกับบัญชี ' + other.id + ' อยู่แล้ว (1 เครื่อง ใช้ได้ 1 คน)');
      }
    }

    let firstTime = false;
    if (!emp.pwHash) {
      // เข้าครั้งแรก: ตั้งรหัสผ่านของตัวเอง
      if (password.length < MIN_PASSWORD_LEN) fail('เข้าใช้ครั้งแรก กรุณาตั้งรหัสผ่านอย่างน้อย ' + MIN_PASSWORD_LEN + ' ตัว', { firstTime: true });
      if (emp.deviceId && emp.deviceId !== deviceId) fail('บัญชีนี้ผูกกับมือถือเครื่องอื่นแล้ว กรุณาแจ้งผู้ดูแลให้กด “รีเซ็ตเครื่อง/รหัสผ่าน”');
      emp.salt = newSecret().slice(0, 16);
      emp.pwHash = hashPassword(password, emp.salt);
      firstTime = true;
    } else if (hashPassword(password, emp.salt) !== emp.pwHash) {
      const left = recordFail('login:' + empId);
      fail(left > 0 ? 'รหัสพนักงานหรือรหัสผ่านไม่ถูกต้อง (เหลือ ' + left + ' ครั้ง)' : 'ใส่รหัสผิดเกิน ' + MAX_FAILS + ' ครั้ง ระบบล็อกไว้ 15 นาที');
    }
    // รหัสผ่านถูก แต่มาจากมือถือ/เบราว์เซอร์ใหม่ (เช่น เปลี่ยนจาก Samsung Internet เป็น Chrome หรือเปลี่ยนมือถือ)
    // ย้ายเองได้ 1 ครั้งทุก DEVICE_SELF_MOVE_DAYS วัน และเก็บประวัติในชีตบันทึกการแก้ไข  เกินกว่านั้นต้องให้ผู้ดูแลรีเซ็ต
    let movedDevice = false;
    if (emp.deviceId && emp.deviceId !== deviceId) {
      const props = PropertiesService.getScriptProperties();
      const moveKey = 'DEVMOVE_' + emp.id;
      const last = props.getProperty(moveKey);
      const daysSince = last ? (Date.now() - Number(last)) / 86400000 : Infinity;
      if (daysSince < DEVICE_SELF_MOVE_DAYS) {
        const nextDate = Utilities.formatDate(new Date(Number(last) + DEVICE_SELF_MOVE_DAYS * 86400000), TZ, 'dd/MM/yyyy');
        fail('บัญชีนี้ใช้กับมือถือหรือเบราว์เซอร์อื่นอยู่ และเพิ่งย้ายไปเมื่อไม่นานนี้ กรุณากลับไปใช้เบราว์เซอร์เดิม ' +
          '(Android ใช้ Chrome, iPhone ใช้ Safari) หรือแจ้งผู้ดูแลให้กด “รีเซ็ตเครื่อง/รหัสผ่าน” (ย้ายเองได้อีกครั้งวันที่ ' + nextDate + ')');
      }
      props.setProperty(moveKey, String(Date.now()));
      movedDevice = true;
    }
    clearFails('login:' + empId);
    const token = newSecret();
    writeCells(sh, emp.row, EMP.DEVICE, [deviceId, emp.pwHash, emp.salt, sha256Hex(token)]);
    if (firstTime) audit(emp.id, 'ลงทะเบียนครั้งแรก', 'ผูกเครื่อง ' + deviceId.slice(-6));
    if (movedDevice) audit(emp.id, 'ย้ายเครื่องเอง (ใช้รหัสผ่าน)', 'เครื่องเดิม ' + emp.deviceId.slice(-6) + ' → เครื่องใหม่ ' + deviceId.slice(-6) + ' | ' + String(d.browser || '').slice(0, 40));
    return { ok: true, token, firstTime, movedDevice, profile: publicEmp(emp) };
  });
}

function handleLogout(d) {
  const emp = requireEmployee(d);
  return withLock(() => {
    const { sh } = loadEmployees();
    writeCells(sh, emp.row, EMP.TOKEN, ['']);
    return { ok: true };
  });
}

function handleChangePassword(d) {
  const emp = requireEmployee(d);
  const cur = String(d.currentPassword || '');
  const next = String(d.newPassword || '');
  checkLockout('login:' + emp.id);
  if (hashPassword(cur, emp.salt) !== emp.pwHash) {
    recordFail('login:' + emp.id);
    fail('รหัสผ่านเดิมไม่ถูกต้อง');
  }
  if (next.length < MIN_PASSWORD_LEN) fail('รหัสผ่านใหม่ต้องมีอย่างน้อย ' + MIN_PASSWORD_LEN + ' ตัว');
  return withLock(() => {
    const { sh } = loadEmployees();
    const salt = newSecret().slice(0, 16);
    writeCells(sh, emp.row, EMP.PWHASH, [hashPassword(next, salt), salt]);
    return { ok: true, message: 'เปลี่ยนรหัสผ่านเรียบร้อยแล้ว' };
  });
}

function handleMe(d) {
  const emp = requireEmployee(d);
  const today = todayStr();
  const since = shiftDate(today, -62);
  const logs = readLogs().filter((l) => l.empId === emp.id && l.date >= since);
  const outings = readOutings().filter((o) => o.empId === emp.id && o.date >= since);
  return { ok: true, profile: publicEmp(emp), today, logs, outings, holidays: loadHolidays(), config: publicConfig(), serverTime: nowTimeStr() };
}

// =====================================================================
//  สแกนเข้า/ออกงาน
// =====================================================================
function handleScan(d) {
  const emp = requireEmployee(d);
  const cfg = getConfig();
  const qr = normId(d.qrCode);
  if (qr && qr !== emp.id) fail('บัตรที่สแกน (' + qr + ') ไม่ใช่บัตรของ ' + emp.id + ' ไม่อนุญาตให้สแกนแทนกัน');
  const geo = checkGeo(d, cfg);
  const photo = checkPhoto(d, cfg);

  const date = todayStr();
  const time = nowTimeStr();
  const mins = parseMins(time);

  const dayOffNow = isDayOff(date, loadHolidays());
  const reasonCode = REASON_CODES[String(d.inReason || '')] ? String(d.inReason) : '';

  // ตรวจเบื้องต้นก่อนอัปโหลดรูป (ไม่ถือคิว)
  decideAction(findLog(readLogRows(), date, emp.id), mins, cfg, dayOffNow, reasonCode);

  const photoUrl = photo ? savePhotoToDrive(photo, date, time, emp.id) : '';
  try {
    return withLock(() => {
      const logSh = sheetWithHeaders(SHEET_LOG, LOG_HEADERS);
      const found = findLog(readLogRows(logSh), date, emp.id);
      const dayOff = isDayOff(date, loadHolidays());
      const action = decideAction(found, mins, cfg, dayOff, reasonCode);
      const distTxt = geo.distance === null ? '-' : geo.distance;
      const coordsTxt = geo.coords || '-';

      if (action === 'in') {
        // เข้าตรงเวลา/วันหยุด ไม่ต้องมีเหตุผล  มาสาย ไม่ต้องรอตรวจ  กรณีอื่นรอผู้ดูแลตรวจ
        const isLate = !dayOff && mins > parseMins(cfg.workStart);
        const reason = isLate ? REASON_CODES[reasonCode] : '';
        const review = (reason && reason !== REASON.LATE) ? REVIEW.PENDING : '';
        const status = inStatusText(mins, cfg, dayOff, reason, review);
        if (found) {
          writeCells(logSh, found.row, LOG.IN, [time, status]);
          writeCells(logSh, found.row, LOG.DIST, [distTxt, coordsTxt, photoUrl]);
          writeCells(logSh, found.row, LOG.REASON, [reason, review]);
        } else {
          appendRowText(logSh, [date, emp.id, emp.name, emp.dept, time, status, '', '', distTxt, coordsTxt, photoUrl, '', '', reason, review]);
        }
        return { ok: true, action: 'in', date, time, status, dayOff, inReason: reason, review };
      }

      const status = outStatusText(mins, cfg, dayOff);
      if (action === 'forgot_out') {
        // ลืมสแกนเข้าตอนเช้า: เก็บเวลานี้เป็น "เวลาออก" แล้วให้ผู้ดูแลเติมเวลาเข้า
        const inSt = 'ไม่มีเวลาเข้า (ลืมสแกน รอผู้ดูแลตรวจ)';
        const note = 'ลืมสแกนเข้า ลงเวลาออก ' + time + ' น. รอผู้ดูแลเติมเวลาเข้า';
        if (found) {
          writeCells(logSh, found.row, LOG.IN_ST, [inSt, time, status, distTxt, coordsTxt]);
          writeCells(logSh, found.row, LOG.PHOTO_OUT, [photoUrl, (found.note ? found.note + ' | ' : '') + note, REASON.FORGOT, REVIEW.PENDING]);
        } else {
          appendRowText(logSh, [date, emp.id, emp.name, emp.dept, '', inSt, time, status, distTxt, coordsTxt, '', photoUrl, note, REASON.FORGOT, REVIEW.PENDING]);
        }
        closeOpenOutings(emp.id, date, time, 'กลับพร้อมเลิกงาน');
        return { ok: true, action: 'out', forgotIn: true, date, time, status, dayOff, inReason: REASON.FORGOT, review: REVIEW.PENDING };
      }
      writeCells(logSh, found.row, LOG.OUT, [time, status]);
      writeCells(logSh, found.row, LOG.PHOTO_OUT, [photoUrl]);
      closeOpenOutings(emp.id, date, time, 'กลับพร้อมเลิกงาน');
      return { ok: true, action: 'out', date, time, status, dayOff };
    });
  } catch (err) {
    trashPhoto(photoUrl);
    throw err;
  }
}

// ตัดสินว่าเป็น เข้า / ออก / ลืมสแกนเข้า-ลงออกเลย (เซิร์ฟเวอร์ตัดสินเอง ไม่เชื่อค่าจากมือถือ)
function decideAction(found, mins, cfg, dayOff, reasonCode) {
  const inT = found ? found.checkIn : '';
  const outT = found ? found.checkOut : '';
  if (inT && outT) fail('ท่านลงเวลาเข้า–ออกงานวันนี้ครบแล้ว (เข้า ' + inT + ' / ออก ' + outT + ')', { done: true });
  if (mins < parseMins(cfg.scanOpen)) fail('ระบบเปิดให้สแกนตั้งแต่ ' + cfg.scanOpen + ' น.');
  if (!inT) {
    if (outT) fail('วันนี้ลงเวลาออกแล้วเมื่อ ' + outT + ' น. (ไม่มีเวลาเข้า) รอผู้ดูแลตรวจ หากผิดพลาดกรุณาแจ้งผู้ดูแล', { done: true });
    // สแกนครั้งแรกหลังเวลาเข้างาน ต้องเลือกเหตุผลก่อน (กันนับสายผิด เช่น ลืมสแกนเช้าแล้วมาสแกนตอนเย็น)
    if (!dayOff && mins > parseMins(cfg.workStart) && !reasonCode) {
      fail('กรุณาเลือกเหตุผลที่สแกนเข้าหลัง ' + cfg.workStart + ' น. (หากไม่เห็นหน้าต่างให้เลือก กรุณาปิดแล้วเปิดหน้าเว็บใหม่)', { needReason: true });
    }
    if (reasonCode === 'forgot_out') {
      if (mins > parseMins(cfg.checkoutClose)) fail('หมดเวลาสแกนออกงานของวันนี้ กรุณาแจ้งผู้ดูแลบันทึกให้');
      return 'forgot_out';
    }
    if (mins > parseMins(cfg.scanClose)) fail('หลัง ' + cfg.scanClose + ' น. สแกนเข้างานไม่ได้ หากมีเหตุจำเป็นกรุณาแจ้งผู้ดูแล');
    return 'in';
  }
  if (mins > parseMins(cfg.checkoutClose)) fail('หมดเวลาสแกนออกงานของวันนี้ กรุณาแจ้งผู้ดูแลบันทึกให้');
  const gap = mins - parseMins(inT);
  if (!isNaN(gap) && gap < MIN_CHECKOUT_GAP_MINS) {
    fail('ลงเวลาเข้างานแล้วเมื่อ ' + inT + ' น. (กันสแกนเบิ้ล: ลงออกได้อีกใน ' + (MIN_CHECKOUT_GAP_MINS - gap) + ' นาที)', { duplicate: true });
  }
  return 'out';
}

// ข้อความสถานะเข้างาน ตามเวลาและเหตุผล
function inStatusText(mins, cfg, dayOff, reason, review) {
  if (dayOff) return 'วันหยุด / OT';
  const start = parseMins(cfg.workStart);
  if (!(mins > start)) return 'ตรงเวลา';
  const pending = review === REVIEW.PENDING ? ' • รอตรวจ' : '';
  if (review !== REVIEW.NO) {
    if (reason === REASON.HALFDAY) {
      const pm = parseMins(cfg.afternoonStart);
      return (mins > pm ? 'ลาครึ่งวันเช้า แต่เข้าสาย (' + (mins - pm) + ' นาที)' : 'ลาครึ่งวันเช้า') + pending;
    }
    if (reason === REASON.OFFICIAL) return 'ไปราชการ/งานนอกสถานที่ช่วงเช้า' + pending;
    if (reason === REASON.FORGOT) return 'ลืมสแกนเข้า (รอผู้ดูแลเติมเวลาจริง)' + pending;
  }
  return 'เข้าสาย (' + (mins - start) + ' นาที)' + (review === REVIEW.NO ? ' (ไม่อนุมัติ ' + reason + ')' : '');
}
function outStatusText(mins, cfg, dayOff) {
  if (dayOff) return 'วันหยุด / OT';
  return mins < parseMins(cfg.workEnd) ? 'ออกก่อนเวลา (' + (parseMins(cfg.workEnd) - mins) + ' นาที)' : 'ปกติ';
}

// =====================================================================
//  ออกนอกสำนักงาน / กลับเข้าสำนักงาน
// =====================================================================
function handleOuting(d) {
  const emp = requireEmployee(d);
  const cfg = getConfig();
  const geo = checkGeo(d, cfg);
  const photo = checkPhoto(d, cfg);
  const action = d.outingAction === 'return' ? 'return' : 'out';
  const date = todayStr();
  const time = nowTimeStr();
  const mins = parseMins(time);
  const reason = String(d.reason || '').trim().slice(0, 300);
  const category = String(d.category || 'ปฏิบัติงานสหกรณ์').trim().slice(0, 60);

  const check = () => {
    const att = findLog(readLogRows(), date, emp.id);
    const open = findOpenOuting(readOutRows(), date, emp.id);
    if (action === 'out') {
      if (!att || !att.checkIn) fail('กรุณาสแกนเข้างานวันนี้ก่อนแจ้งออกนอกสำนักงาน');
      if (att.checkOut) fail('ท่านลงเวลาเลิกงานวันนี้ไปแล้วเมื่อ ' + att.checkOut + ' น.');
      if (mins < parseMins(cfg.outingStart) || mins > parseMins(cfg.outingEnd)) fail('แจ้งออกนอกสำนักงานได้เฉพาะ ' + cfg.outingStart + ' – ' + cfg.outingEnd + ' น.');
      if (open) fail('ท่านแจ้งออกไปแล้วเมื่อ ' + open.outTime + ' น. กรุณาสแกนกลับก่อน');
      if (reason.length < 3) fail('กรุณาระบุเหตุผลหรือสถานที่อย่างน้อย 3 ตัวอักษร');
    } else {
      if (!open) fail('ไม่พบรายการแจ้งออกของท่านในวันนี้ กรุณาแจ้งออกก่อนสแกนกลับ');
      const gap = mins - parseMins(open.outTime);
      if (!isNaN(gap) && gap < MIN_OUTING_RETURN_MINS) fail('เพิ่งแจ้งออกไปเมื่อ ' + open.outTime + ' น. (รออย่างน้อย ' + MIN_OUTING_RETURN_MINS + ' นาที)');
    }
    return open;
  };
  check();

  const photoUrl = photo ? savePhotoToDrive(photo, date, time, emp.id + (action === 'out' ? '_OUT' : '_RET')) : '';
  try {
    return withLock(() => {
      const open = check();
      const outSh = sheetWithHeaders(SHEET_OUT, OUT_HEADERS);
      closeStaleOutings(emp.id, date);
      if (action === 'out') {
        appendRowText(outSh, [date, emp.id, emp.name, emp.dept, category, reason, time, '', 0, 'อยู่นอกสำนักงาน', photoUrl, '']);
        return { ok: true, outingAction: 'out', date, time, status: 'อยู่นอกสำนักงาน', geoDistance: geo.distance };
      }
      const mOut = parseMins(open.outTime);
      const dur = (!isNaN(mOut) && mins >= mOut) ? mins - mOut : 0;
      writeCells(outSh, open.row, OUT.RET, [time, dur, 'กลับเข้าสำนักงานแล้ว']);
      writeCells(outSh, open.row, OUT.PHOTO_RET, [photoUrl]);
      return { ok: true, outingAction: 'return', date, time, durationMins: dur, status: 'กลับเข้าสำนักงานแล้ว' };
    });
  } catch (err) {
    trashPhoto(photoUrl);
    throw err;
  }
}

function closeOpenOutings(empId, date, time, status) {
  const sh = ss().getSheetByName(SHEET_OUT);
  if (!sh) return;
  const open = findOpenOuting(readOutRows(sh), date, empId);
  if (!open) return;
  const mOut = parseMins(open.outTime);
  const mNow = parseMins(time);
  const dur = (!isNaN(mOut) && mNow >= mOut) ? mNow - mOut : 0;
  writeCells(sh, open.row, OUT.RET, [time, dur, status]);
}

// ปิดรายการออกนอกพื้นที่ของวันก่อนๆ ที่ลืมสแกนกลับ
function closeStaleOutings(empId, today) {
  const sh = ss().getSheetByName(SHEET_OUT);
  if (!sh) return;
  readOutRows(sh).forEach((o) => {
    if (o.empId === empId && o.date && o.date < today && !o.returnTime) {
      writeCells(sh, o.row, OUT.STATUS, ['ไม่ได้สแกนกลับ']);
      writeCells(sh, o.row, OUT.RET, ['-']);
    }
  });
}

// =====================================================================
//  ผู้ดูแล
// =====================================================================
function handleAdminChangePin(d) {
  requireAdmin(d);
  const next = String(d.newPin || '').trim();
  if (!/^\d{6,12}$/.test(next)) fail('PIN ใหม่ต้องเป็นตัวเลข ' + MIN_PIN_LEN + '–12 หลัก');
  PropertiesService.getScriptProperties().setProperty('ADMIN_PIN', next);
  audit('ผู้ดูแล', 'เปลี่ยน PIN', '');
  return { ok: true, message: 'เปลี่ยนรหัส PIN สำเร็จ' };
}

function handleAdminData(d) {
  requireAdmin(d);
  const today = todayStr();
  const since = /^\d{4}-\d{2}-\d{2}$/.test(String(d.since || '')) ? String(d.since) : shiftDate(today, -120);
  const { rows } = loadEmployees();
  const employees = rows.map(empFromRow).filter((e) => e.id).map((e) => ({
    id: e.id, name: e.name, dept: e.dept,
    deviceBound: Boolean(e.deviceId), deviceTail: e.deviceId ? e.deviceId.slice(-6) : '',
    hasPassword: Boolean(e.pwHash), loggedIn: Boolean(e.tokenHash)
  }));
  return {
    ok: true, today, employees,
    logs: readLogs().filter((l) => l.date >= since),
    outings: readOutings().filter((o) => o.date >= since),
    holidays: loadHolidays(),
    config: publicConfig()
  };
}

function handleAdminPhoto(d) {
  requireAdmin(d);
  const id = driveIdFromUrl(String(d.url || ''));
  if (!id) fail('ไม่พบรูป');
  const file = DriveApp.getFileById(id);
  const parents = file.getParents();
  let inFolder = false;
  while (parents.hasNext()) { if (parents.next().getName() === PHOTO_FOLDER) inFolder = true; }
  if (!inFolder) fail('ไม่อนุญาตให้เปิดไฟล์นี้');
  const blob = file.getBlob();
  return { ok: true, dataUrl: 'data:' + blob.getContentType() + ';base64,' + Utilities.base64Encode(blob.getBytes()) };
}

// ผู้ดูแลบันทึก/แก้เวลาแทนพนักงาน (ไม่ผูกเครื่อง ไม่ตรวจ GPS) และเก็บประวัติการแก้ไข
function handleAdminRecord(d) {
  requireAdmin(d);
  const cfg = getConfig();
  const action = d.action === 'out' ? 'out' : 'in';
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(d.date || '')) ? String(d.date) : todayStr();
  const time = /^\d{2}:\d{2}$/.test(String(d.time || '')) ? String(d.time) : nowTimeStr();
  const note = String(d.note || '').trim().slice(0, 200);
  if (note.length < 3) fail('กรุณาระบุเหตุผลที่บันทึกแทน อย่างน้อย 3 ตัวอักษร');
  if (date > todayStr()) fail('บันทึกล่วงหน้าไม่ได้');
  return withLock(() => {
    const emp = findEmp(loadEmployees().rows, d.empId);
    if (!emp) fail('ไม่พบรหัสพนักงาน ' + normId(d.empId));
    const logSh = sheetWithHeaders(SHEET_LOG, LOG_HEADERS);
    const found = findLog(readLogRows(logSh), date, emp.id);
    const mins = parseMins(time);
    const dayOff = isDayOff(date, loadHolidays());
    const tag = ' (ผู้ดูแลบันทึก)';
    let status;
    if (action === 'in') {
      status = (dayOff ? 'วันหยุด / OT' : (mins > parseMins(cfg.workStart) ? 'เข้าสาย (' + (mins - parseMins(cfg.workStart)) + ' นาที)' : 'ตรงเวลา')) + tag;
    } else {
      status = (dayOff ? 'วันหยุด / OT' : (mins < parseMins(cfg.workEnd) ? 'ออกก่อนเวลา (' + (parseMins(cfg.workEnd) - mins) + ' นาที)' : 'ปกติ')) + tag;
    }
    const col = action === 'in' ? LOG.IN : LOG.OUT;
    const oldVal = found ? (action === 'in' ? found.checkIn : found.checkOut) : '';
    if (found) {
      writeCells(logSh, found.row, col, [time, status]);
      writeCells(logSh, found.row, LOG.NOTE, [(found.note ? found.note + ' | ' : '') + note]);
      // ผู้ดูแลใส่เวลาเข้าจริงแล้ว: ล้างสถานะ "ลืมสแกนเข้า" ให้คิดสาย/ไม่สายจากเวลาที่ใส่
      if (action === 'in' && found.reason === REASON.FORGOT) writeCells(logSh, found.row, LOG.REASON, ['', '']);
    } else {
      const row = [date, emp.id, emp.name, emp.dept, '', '', '', '', '-', '-', '', '', note, '', ''];
      row[col - 1] = time; row[col] = status;
      appendRowText(logSh, row);
    }
    audit('ผู้ดูแล', 'บันทึกเวลา' + (action === 'in' ? 'เข้า' : 'ออก') + 'แทน', emp.id + ' ' + date + ' ' + (oldVal || '-') + ' → ' + time + ' : ' + note);
    return { ok: true, date, time, status };
  });
}

// ผู้ดูแลตรวจเหตุผลเข้าหลังเวลา: อนุมัติ / ไม่อนุมัติ (นับสาย) / เปลี่ยนเหตุผล / ย้ายเวลาเข้าไปเป็นเวลาออก
function handleAdminReview(d) {
  requireAdmin(d);
  const cfg = getConfig();
  const decision = String(d.decision || '');
  const note = String(d.note || '').trim().slice(0, 200);
  if (['approve', 'reject', 'halfday', 'official', 'late', 'to_out'].indexOf(decision) < 0) fail('คำสั่งไม่ถูกต้อง');
  if (decision !== 'approve' && note.length < 3) fail('กรุณาระบุเหตุผล อย่างน้อย 3 ตัวอักษร');
  return withLock(() => {
    const logSh = sheetWithHeaders(SHEET_LOG, LOG_HEADERS);
    const date = String(d.date || '');
    const found = findLog(readLogRows(logSh), date, normId(d.empId));
    if (!found) fail('ไม่พบรายการ');
    const dayOff = isDayOff(date, loadHolidays());
    const mins = parseMins(found.checkIn);
    let reason = found.reason;
    let review = found.review;
    let label = '';
    if (decision === 'to_out') {
      if (!found.checkIn || found.checkOut) fail('ใช้ได้เฉพาะรายการที่มีเวลาเข้าแต่ยังไม่มีเวลาออก');
      const outSt = outStatusText(mins, cfg, dayOff) + ' (ผู้ดูแลแก้)';
      writeCells(logSh, found.row, LOG.IN, ['', 'ไม่มีเวลาเข้า (ลืมสแกน)', found.checkIn, outSt]);
      writeCells(logSh, found.row, LOG.PHOTO_IN, ['', found.photoIn || found.photoOut]);
      reason = REASON.FORGOT; review = REVIEW.OK;
      label = 'ย้ายเวลา ' + found.checkIn + ' เป็นเวลาออก (ลืมสแกนเข้า)';
    } else {
      if (!found.checkIn && decision !== 'approve' && decision !== 'reject') fail('รายการนี้ไม่มีเวลาเข้า ใช้ปุ่ม "บันทึกเข้า" เพื่อเติมเวลาเข้าจริง');
      if (decision === 'approve') { if (!reason) fail('รายการนี้ไม่มีเหตุผลให้อนุมัติ'); review = REVIEW.OK; }
      if (decision === 'reject') { review = REVIEW.NO; }
      if (decision === 'halfday') { reason = REASON.HALFDAY; review = REVIEW.OK; }
      if (decision === 'official') { reason = REASON.OFFICIAL; review = REVIEW.OK; }
      if (decision === 'late') { reason = REASON.LATE; review = ''; }
      if (found.checkIn) writeCells(logSh, found.row, LOG.IN_ST, [inStatusText(mins, cfg, dayOff, reason, review)]);
      label = { approve: 'อนุมัติ', reject: 'ไม่อนุมัติ (นับสาย)', halfday: 'เปลี่ยนเป็นลาครึ่งวันเช้า', official: 'เปลี่ยนเป็นไปราชการ', late: 'เปลี่ยนเป็นมาสาย' }[decision];
    }
    writeCells(logSh, found.row, LOG.REASON, [reason, review]);
    if (note) writeCells(logSh, found.row, LOG.NOTE, [(found.note ? found.note + ' | ' : '') + 'ผู้ดูแล: ' + note]);
    audit('ผู้ดูแล', 'ตรวจเหตุผลเข้าหลังเวลา', found.empId + ' ' + date + ' ' + label + (note ? ' : ' + note : ''));
    return { ok: true, message: label };
  });
}

function handleAdminResetDevice(d) {
  requireAdmin(d);
  return withLock(() => {
    const { sh, rows } = loadEmployees();
    const emp = findEmp(rows, d.empId);
    if (!emp) fail('ไม่พบรหัสพนักงาน');
    // ล้างเครื่อง, รหัสผ่าน, token  พนักงานจะตั้งรหัสผ่านใหม่ตอน login ครั้งถัดไป
    writeCells(sh, emp.row, EMP.DEVICE, ['', '', '', '']);
    clearFails('login:' + emp.id);
    PropertiesService.getScriptProperties().deleteProperty('DEVMOVE_' + emp.id);
    audit('ผู้ดูแล', 'รีเซ็ตเครื่อง/รหัสผ่าน', emp.id);
    return { ok: true, message: 'รีเซ็ตแล้ว ให้ ' + emp.name + ' เข้าสู่ระบบบนมือถือของตัวเองและตั้งรหัสผ่านใหม่' };
  });
}

function handleAdminSaveEmployee(d) {
  requireAdmin(d);
  const id = normId(d.id);
  const name = String(d.name || '').trim().slice(0, 100);
  const dept = String(d.dept || '').trim().slice(0, 60);
  const origId = normId(d.origId);
  if (!/^[A-Z0-9-]{2,20}$/.test(id)) fail('รหัสพนักงานใช้ได้เฉพาะ A-Z 0-9 และ - (2–20 ตัว)');
  if (!name || !dept) fail('กรุณากรอกชื่อและแผนก');
  return withLock(() => {
    const { sh, rows } = loadEmployees();
    const dup = findEmp(rows, id);
    if (origId) {
      const emp = findEmp(rows, origId);
      if (!emp) fail('ไม่พบรหัสพนักงาน ' + origId);
      if (id !== origId) fail('เปลี่ยนรหัสพนักงานไม่ได้ เพราะประวัติเดิมผูกกับรหัสนี้ (แก้ได้เฉพาะชื่อและแผนก)');
      writeCells(sh, emp.row, EMP.NAME, [name, dept]);
      audit('ผู้ดูแล', 'แก้ข้อมูลพนักงาน', id + ' ' + name + ' / ' + dept);
    } else {
      if (dup) fail('รหัสพนักงาน ' + id + ' มีอยู่แล้ว');
      appendRowText(sh, [id, name, dept, '', '', '', '', '']);
      audit('ผู้ดูแล', 'เพิ่มพนักงาน', id + ' ' + name + ' / ' + dept);
    }
    return { ok: true };
  });
}

function handleAdminDeleteEmployee(d) {
  requireAdmin(d);
  return withLock(() => {
    const { sh, rows } = loadEmployees();
    const emp = findEmp(rows, d.empId);
    if (!emp) fail('ไม่พบรหัสพนักงาน');
    sh.deleteRow(emp.row);  // ประวัติลงเวลาเดิมยังอยู่ในชีตประวัติ
    audit('ผู้ดูแล', 'ลบพนักงาน', emp.id + ' ' + emp.name);
    return { ok: true };
  });
}

function handleAdminDeleteLog(d) {
  requireAdmin(d);
  return withLock(() => {
    const logSh = sheetWithHeaders(SHEET_LOG, LOG_HEADERS);
    const found = findLog(readLogRows(logSh), String(d.date || ''), normId(d.empId));
    if (!found) fail('ไม่พบรายการ');
    logSh.deleteRow(found.row);
    audit('ผู้ดูแล', 'ลบรายการลงเวลา', found.empId + ' ' + found.date + ' เข้า ' + (found.checkIn || '-') + ' ออก ' + (found.checkOut || '-'));
    return { ok: true };
  });
}

function handleAdminSetConfig(d) {
  requireAdmin(d);
  const c = d.config || {};
  const props = PropertiesService.getScriptProperties();
  const set = {};
  const num = (v, min, max) => { const n = Number(v); if (!isFinite(n) || n < min || n > max) return null; return String(n); };
  const hhmm = (v) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(v || '')) ? String(v) : null;
  if (c.coopLat !== undefined) { const v = num(c.coopLat, -90, 90); if (v === null) fail('ละติจูดไม่ถูกต้อง'); set.COOP_LAT = v; }
  if (c.coopLng !== undefined) { const v = num(c.coopLng, -180, 180); if (v === null) fail('ลองจิจูดไม่ถูกต้อง'); set.COOP_LNG = v; }
  if (c.radiusM !== undefined) { const v = num(c.radiusM, 20, 2000); if (v === null) fail('รัศมีต้องอยู่ระหว่าง 20–2000 ม.'); set.GEO_RADIUS_M = v; }
  if (c.maxAccuracyM !== undefined) { const v = num(c.maxAccuracyM, 10, 500); if (v === null) fail('ค่าความแม่นยำ GPS ต้องอยู่ระหว่าง 10–500 ม.'); set.GEO_MAX_ACCURACY_M = v; }
  if (c.geoEnforced !== undefined) set.GEO_ENFORCED = c.geoEnforced ? 'true' : 'false';
  if (c.photoRequired !== undefined) set.PHOTO_REQUIRED = c.photoRequired ? 'true' : 'false';
  [['workStart', 'WORK_START'], ['workEnd', 'WORK_END'], ['afternoonStart', 'AFTERNOON_START'], ['scanOpen', 'SCAN_OPEN'], ['scanClose', 'SCAN_CLOSE'],
   ['checkoutClose', 'CHECKOUT_CLOSE'], ['outingStart', 'OUTING_START'], ['outingEnd', 'OUTING_END']].forEach(([k, p]) => {
    if (c[k] !== undefined) { const v = hhmm(c[k]); if (v === null) fail('รูปแบบเวลา ' + k + ' ต้องเป็น HH:mm'); set[p] = v; }
  });
  props.setProperties(set);
  audit('ผู้ดูแล', 'แก้ตั้งค่าระบบ', JSON.stringify(set));
  return { ok: true, config: publicConfig() };
}

// =====================================================================
//  ตรวจ GPS และรูป
// =====================================================================
function checkGeo(d, cfg) {
  const lat = Number(d.lat), lng = Number(d.lng), acc = Number(d.accuracy);
  const hasCoords = d.lat !== '' && d.lng !== '' && d.lat !== null && d.lng !== null && isFinite(lat) && isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
  const coords = hasCoords ? lat.toFixed(6) + ', ' + lng.toFixed(6) : '';
  if (!cfg.geoEnforced) {
    return { distance: hasCoords ? Math.round(haversineMeters(lat, lng, cfg.coopLat, cfg.coopLng)) : null, coords };
  }
  if (!hasCoords) fail('ไม่พบพิกัด GPS จากเครื่อง กรุณากด “อัปเดต GPS” แล้วลองใหม่');
  if (d.accuracy === '' || d.accuracy === null || d.accuracy === undefined || !isFinite(acc) || acc <= 0) {
    fail('ไม่พบค่าความแม่นยำ GPS กรุณากด “อัปเดต GPS” แล้วลองใหม่');
  }
  if (acc > cfg.maxAccuracyM) fail('สัญญาณ GPS ไม่แม่นพอ (±' + Math.round(acc) + ' ม. / ต้องไม่เกิน ±' + cfg.maxAccuracyM + ' ม.)');
  const distance = Math.round(haversineMeters(lat, lng, cfg.coopLat, cfg.coopLng));
  if (distance > cfg.radiusM) fail('อยู่นอกรัศมีสหกรณ์ (ห่าง ' + distance + ' ม. / อนุญาตไม่เกิน ' + cfg.radiusM + ' ม.)');
  return { distance, coords };
}

function checkPhoto(d, cfg) {
  const p = String(d.photoBase64 || '');
  if (!p) {
    if (cfg.photoRequired) fail('ต้องถ่ายรูปยืนยันตัวตนทุกครั้ง');
    return '';
  }
  if (!/^data:image\/(jpeg|png|webp);base64,/.test(p)) fail('รูปแบบรูปไม่ถูกต้อง');
  if (p.length > MAX_PHOTO_CHARS) fail('รูปมีขนาดใหญ่เกินไป');
  if (p.length < 2000) fail('รูปไม่ชัดหรือเป็นภาพว่าง กรุณาถ่ายใหม่');
  return p;
}

function haversineMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (x) => x * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// =====================================================================
//  รูปถ่าย (ไม่แชร์สาธารณะ ผู้ดูแลเปิดผ่านแอปด้วย PIN)
// =====================================================================
function photoFolder() {
  const it = DriveApp.getFoldersByName(PHOTO_FOLDER);
  return it.hasNext() ? it.next() : DriveApp.createFolder(PHOTO_FOLDER);
}
function savePhotoToDrive(dataUrl, date, time, suffix) {
  const m = dataUrl.match(/^data:(image\/[a-z]+);base64,(.*)$/);
  const bytes = Utilities.base64Decode(m[2]);
  const name = date + '_' + time.replace(':', '-') + '_' + suffix + '.jpg';
  const file = photoFolder().createFile(Utilities.newBlob(bytes, m[1], name));
  return file.getUrl();
}
function trashPhoto(url) {
  const id = driveIdFromUrl(url);
  if (!id) return;
  try { DriveApp.getFileById(id).setTrashed(true); } catch (e) { console.warn('trash failed ' + id); }
}
function driveIdFromUrl(url) {
  const m = String(url || '').match(/[-\w]{25,}/);
  return m ? m[0] : '';
}

// เรียกครั้งเดียวหลังติดตั้ง: ปิดการแชร์สาธารณะของรูปเก่าทั้งหมด
function makeOldPhotosPrivate() {
  const files = photoFolder().getFiles();
  let n = 0;
  while (files.hasNext()) {
    const f = files.next();
    try { f.setSharing(DriveApp.Access.PRIVATE, DriveApp.Permission.NONE); n++; } catch (e) { console.warn(f.getName()); }
  }
  Logger.log('ปิดแชร์แล้ว ' + n + ' ไฟล์');
}

function authorizeDrive() {
  Logger.log('พร้อมใช้งาน: ' + photoFolder().getUrl());
}

// =====================================================================
//  อ่านประวัติ
// =====================================================================
function readLogRows(sh) {
  const s = sh || ss().getSheetByName(SHEET_LOG);
  if (!s) return [];
  return readRows(s, LOG.WIDTH).map((r, i) => ({
    row: i + 2,
    date: fmtDate(r[LOG.DATE - 1]),
    empId: normId(r[LOG.EMP - 1]),
    checkIn: fmtTime(r[LOG.IN - 1]),
    statusIn: String(r[LOG.IN_ST - 1] || '').trim(),
    checkOut: fmtTime(r[LOG.OUT - 1]),
    statusOut: String(r[LOG.OUT_ST - 1] || '').trim(),
    distance: String(r[LOG.DIST - 1] || '').trim(),
    photoIn: String(r[LOG.PHOTO_IN - 1] || '').trim(),
    photoOut: String(r[LOG.PHOTO_OUT - 1] || '').trim(),
    note: String(r[LOG.NOTE - 1] || '').trim(),
    reason: String(r[LOG.REASON - 1] || '').trim(),
    review: String(r[LOG.REVIEW - 1] || '').trim()
  })).filter((l) => l.empId);
}
function findLog(rows, date, empId) {
  for (let i = 0; i < rows.length; i++) if (rows[i].date === date && rows[i].empId === empId) return rows[i];
  return null;
}
function readLogs() {
  const hol = loadHolidays();
  return readLogRows().map((l) => ({
    logId: l.date + '_' + l.empId, date: l.date, empId: l.empId,
    checkIn: l.checkIn, statusIn: l.statusIn, checkOut: l.checkOut, statusOut: l.statusOut,
    distance: l.distance, note: l.note, dayOff: isDayOff(l.date, hol),
    inReason: l.reason, review: l.review,
    photoUrl: l.photoIn, photoOutUrl: l.photoOut
  }));
}
function readOutRows(sh) {
  const s = sh || ss().getSheetByName(SHEET_OUT);
  if (!s) return [];
  return readRows(s, OUT.WIDTH).map((r, i) => ({
    row: i + 2,
    date: fmtDate(r[OUT.DATE - 1]),
    empId: normId(r[OUT.EMP - 1]),
    category: String(r[OUT.CAT - 1] || '').trim(),
    reason: String(r[OUT.REASON - 1] || '').trim(),
    outTime: fmtTime(r[OUT.OUT - 1]),
    returnTime: fmtTime(r[OUT.RET - 1]),
    durationMins: Number(r[OUT.DUR - 1]) || 0,
    status: String(r[OUT.STATUS - 1] || '').trim(),
    photoUrl: String(r[OUT.PHOTO_OUT - 1] || '').trim(),
    photoRetUrl: String(r[OUT.PHOTO_RET - 1] || '').trim()
  })).filter((o) => o.empId);
}
function findOpenOuting(rows, date, empId) {
  for (let i = rows.length - 1; i >= 0; i--) {
    const o = rows[i];
    if (o.date === date && o.empId === empId && !o.returnTime) return o;
  }
  return null;
}
function readOutings() {
  return readOutRows().map((o) => Object.assign({ outingId: o.date + '_' + o.empId + '_' + o.row }, o));
}

// =====================================================================
//  เครื่องมือ
// =====================================================================
function withLock(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    return fn();
  } finally {
    SpreadsheetApp.flush();
    lock.releaseLock();
  }
}
function normId(v) { return String(v || '').trim().toUpperCase(); }
function todayStr() { return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd'); }
function nowTimeStr() { return Utilities.formatDate(new Date(), TZ, 'HH:mm'); }
function shiftDate(dateStr, days) {
  const p = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(p[0], p[1] - 1, p[2] + days));
  return dt.toISOString().slice(0, 10);
}
function fmtDate(v) {
  return v instanceof Date ? Utilities.formatDate(v, TZ, 'yyyy-MM-dd') : String(v || '').trim();
}
function fmtTime(v) {
  if (v instanceof Date) return Utilities.formatDate(v, TZ, 'HH:mm');
  const s = String(v || '').trim();
  const m = s.match(/^(\d{1,2}):(\d{2})/);
  return m ? ('0' + m[1]).slice(-2) + ':' + m[2] : s;
}
function parseMins(hhmm) {
  const m = String(hhmm || '').match(/^(\d{1,2}):(\d{2})/);
  return m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : NaN;
}
function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
