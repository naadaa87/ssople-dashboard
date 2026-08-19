/* ============================================================
   쏘플 실운영 API  (functions/api/ops.js)
   대시보드 ↔ 실테이블(reservations 등) 직결.
   - 호스트 규약 준수: 소문자 5상태 · day/night 슬롯 · code 예약번호
   - 서버가 강제: 상태 전이 표 · 이중예약 · 원장 추가만 · 분쟁 상태 랭크
   - Cloudflare Access가 같은 주소를 잠그므로 별도 인증 없음.
     역할은 x-ssople-role 헤더(master/staff)로 전달 — 정책 저장은 master만.
   ============================================================ */

let ready = false;
async function ensure(db) {
  if (ready) return;
  await db.batch(["dash_added","dash_patch","dash_branch","dash_kv"].map(t =>
    db.prepare(`CREATE TABLE IF NOT EXISTS ${t} (k TEXT PRIMARY KEY, v TEXT, ts INTEGER, by TEXT)`)));
  ready = true;
}
const J = (o, s = 200) => new Response(JSON.stringify(o), {
  status: s, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }});

/* 소문자 5상태 전이 표 — 운영 예외 2종 포함 (5.1) */
const FLOW = {
  waiting:   ["confirmed", "canceled"],
  confirmed: ["completed", "canceled", "noshow"],
  completed: [],
  canceled:  [],
  noshow:    ["completed"]                 // 24시간 정정
};
const ACTIVE = "('waiting','confirmed','completed')";

async function readPolicy(db){
  const rows = (await db.prepare(`SELECT key, value FROM web_settings`).all()).results || [];
  const flat = {}; rows.forEach(r => flat[r.key] = r.value);
  let pol = {};
  try { pol = JSON.parse(flat["dash.policy"] || "{}"); } catch(e){ pol = {}; }
  if (flat["deposit.amount"])  pol.deposit = Number(flat["deposit.amount"]) || pol.deposit;
  if (flat["settle.hq_rate"])  pol.feeRate = (Number(flat["settle.hq_rate"]) || 20) / 100;
  try {
    const rules = JSON.parse(flat["refund.rules"] || "[]");
    const full = rules.find(r => r.rate >= 100);
    if (full) pol.refundFullDays = full.min_days;
  } catch(e){}
  return pol;
}
async function writePolicy(db, pol, now){
  const put = (k, v) => db.prepare(
    `INSERT INTO web_settings (key, value, updated_at) VALUES (?,?,datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`)
    .bind(k, String(v)).run();
  await put("dash.policy", JSON.stringify(pol));
  if (pol.deposit)  await put("deposit.amount", pol.deposit);
  if (pol.feeRate != null){
    await put("settle.hq_rate", Math.round(pol.feeRate * 100));
    await put("settle.owner_rate", 100 - Math.round(pol.feeRate * 100));
  }
  if (pol.refundFullDays)
    await put("refund.rules", JSON.stringify([
      { min_days: pol.refundFullDays, rate: 100, type: "full", label: `${pol.refundFullDays}일 전 전액 환불` },
      { min_days: 0, rate: 0, type: "none", label: "그 이후 환불 불가" }]));
}

export async function onRequest(context) {
  const { request, env } = context;
  const db = env.DB;
  if (!db) return J({ ok: false, error:
    "D1 바인딩(DB)이 없습니다 — Pages 설정에서 ssople-host 데이터베이스를 변수명 DB로 연결하세요." }, 500);

  const url = new URL(request.url);
  const op = url.searchParams.get("op") || "";
  const role = request.headers.get("x-ssople-role") || "staff";
  let actor = request.headers.get("x-ssople-actor") || "";
  try { actor = decodeURIComponent(actor); } catch (e) {}
  actor = actor.slice(0, 40);

  try {
    await ensure(db);

    /* ── 부트: 지점 맵 + 운영 데이터 전체(경계 내) + 남은 kv ── */
    if (request.method === "GET" && op === "boot") {
      const q = async (sql, ...a) => (await db.prepare(sql).bind(...a).all()).results || [];
      const cut = daysAgoStr(180);
      const [branches, res, ext, ledger, events, incidents, recon, locks, holds, kv,
             reviews, cinq, oinq, points, orders, leads] =
        await Promise.all([
          q(`SELECT id, code, name, day_price, night_price, base_people, extra_price, max_people, status FROM branches WHERE status = 'open'`),
          q(`SELECT r.*, b.code AS branch_code FROM reservations r JOIN branches b ON b.id = r.branch_id WHERE r.use_date >= ? ORDER BY r.use_date DESC LIMIT 6000`, cut),
          q(`SELECT * FROM res_ext`),
          q(`SELECT * FROM ops_ledger ORDER BY at DESC LIMIT 800`),
          q(`SELECT * FROM ops_events ORDER BY at DESC LIMIT 400`),
          q(`SELECT * FROM ops_incidents`),
          q(`SELECT * FROM ops_recon ORDER BY at DESC LIMIT 200`),
          q(`SELECT * FROM ops_slot_locks`),
          q(`SELECT * FROM ops_pay_hold WHERE held = 1`),
          q(`SELECT k, v, ts FROM dash_kv`),
          q(`SELECT rv.*, COALESCE(c.name, rv.writer) AS cust_name FROM reviews rv LEFT JOIN customers c ON c.id = rv.customer_id ORDER BY rv.id DESC LIMIT 500`),
          q(`SELECT * FROM cust_inquiries ORDER BY id DESC LIMIT 300`),
          q(`SELECT oi.*, b.code AS branch_code, u.name AS owner_name FROM owner_inquiries oi
             JOIN branches b ON b.id = oi.branch_id LEFT JOIN users u ON u.id = oi.user_id
             ORDER BY oi.id DESC LIMIT 200`),
          q(`SELECT * FROM cust_points ORDER BY id DESC LIMIT 500`),
          q(`SELECT * FROM partner_orders ORDER BY id DESC LIMIT 300`),
          q(`SELECT * FROM franchise_leads ORDER BY id DESC LIMIT 100`)
        ]);
      return J({ ok: true, live: true, now: Date.now(),
        branches, res, ext, ledger, events, incidents, recon, locks, holds, kv,
        reviews, cinq, oinq, points, orders, leads,
        settings: { policy: JSON.stringify(await readPolicy(db)) } });
    }

    /* ── 증분: up/at 기준 변경분 ── */
    if (request.method === "GET" && op === "pull") {
      const since = Number(url.searchParams.get("since") || 0) || 0;
      const q = async (sql) => (await db.prepare(sql).bind(since).all()).results || [];
      const [ext, ledger, events, incidents, recon, locks, holds, kv] = await Promise.all([
        q(`SELECT * FROM res_ext WHERE up > ?`),
        q(`SELECT * FROM ops_ledger WHERE at > ?`),
        q(`SELECT * FROM ops_events WHERE at > ?`),
        q(`SELECT * FROM ops_incidents WHERE up > ?`),
        q(`SELECT * FROM ops_recon WHERE up > ?`),
        q(`SELECT * FROM ops_slot_locks WHERE up > ?`),
        q(`SELECT * FROM ops_pay_hold WHERE up > ?`),
        q(`SELECT k, v, ts FROM dash_kv WHERE ts > ?`)
      ]);
      /* 어느 서비스가 썼든 touch 도장으로 잡아낸다 */
      const touch = (await db.prepare(`SELECT tbl, rid FROM ops_touch WHERE up > ?`).bind(since).all()).results || [];
      const byT = {}; touch.forEach(t => (byT[t.tbl] ||= []).push(t.rid));
      const fetchIn = async (sql, ids) => {
        if (!ids || !ids.length) return [];
        const marks = ids.map(() => "?").join(",");
        return (await db.prepare(sql.replace("__IN__", marks)).bind(...ids).all()).results || [];
      };
      const codes = [...new Set([...(byT.res || []), ...ext.map(e => e.code)])];
      const res = await fetchIn(`SELECT r.*, b.code AS branch_code FROM reservations r JOIN branches b ON b.id = r.branch_id WHERE r.code IN (__IN__)`, codes);
      const ext2 = await fetchIn(`SELECT * FROM res_ext WHERE code IN (__IN__)`, codes);
      const reviews = await fetchIn(`SELECT rv.*, COALESCE(c.name, rv.writer) AS cust_name FROM reviews rv LEFT JOIN customers c ON c.id = rv.customer_id WHERE rv.id IN (__IN__)`, byT.review);
      const cinq = await fetchIn(`SELECT * FROM cust_inquiries WHERE id IN (__IN__)`, byT.cinq);
      const oinq = await fetchIn(`SELECT oi.*, b.code AS branch_code, u.name AS owner_name FROM owner_inquiries oi JOIN branches b ON b.id = oi.branch_id LEFT JOIN users u ON u.id = oi.user_id WHERE oi.id IN (__IN__)`, byT.oinq);
      const points = await fetchIn(`SELECT * FROM cust_points WHERE id IN (__IN__)`, byT.point);
      const orders = await fetchIn(`SELECT * FROM partner_orders WHERE id IN (__IN__)`, byT.order);
      const leads = await fetchIn(`SELECT * FROM franchise_leads WHERE id IN (__IN__)`, byT.lead);
      return J({ ok: true, now: Date.now(), res, ext: [...ext, ...ext2], ledger, events, incidents, recon, locks, holds,
        reviews, cinq, oinq, points, orders, leads, kv,
        settings: { policy: JSON.stringify(await readPolicy(db)) } });
    }

    /* ── 동기화: 대시보드 변경분 반영 (서버 규칙이 최종심) ── */
    if (request.method === "PUT" && op === "sync") {
      let b; try { b = await request.json(); } catch (e) { return J({ ok: false, error: "bad json" }, 400); }
      const now = Date.now();
      const rejected = [];
      const idMap = { ledger: {}, events: {}, incidents: {}, recon: {} };

      /* 지점 코드 → id */
      const bMap = {};
      ((await db.prepare(`SELECT id, code FROM branches`).all()).results || [])
        .forEach(r => bMap[r.code] = r.id);

      /* ① 예약 upsert — 전이 · 이중예약 · 잠금 검사 */
      for (const r of (b.res || [])) {
        const bid = bMap[r.branch_code];
        if (!bid) { rejected.push({ code: r.code, reason: "지점이 D1에 없습니다: " + r.branch_code }); continue; }
        const cur = (await db.prepare(`SELECT status FROM reservations WHERE code = ?`).bind(r.code).all()).results?.[0];
        if (cur) {
          if (cur.status !== r.status && !(FLOW[cur.status] || []).includes(r.status)) {
            rejected.push({ code: r.code, reason: `전이 불가 ${cur.status} → ${r.status} (5.1)` }); continue;
          }
        } else {
          const lock = (await db.prepare(`SELECT id FROM ops_slot_locks WHERE id = ?`)
            .bind(`${r.branch_code}|${r.use_date}|${r.slot}`).all()).results?.[0];
          if (lock) { rejected.push({ code: r.code, reason: "긴급 잠금 슬롯 (표 6-9①)" }); continue; }
          const dup = (await db.prepare(
            `SELECT code FROM reservations WHERE branch_id = ? AND use_date = ? AND slot = ? AND status IN ${ACTIVE} LIMIT 1`)
            .bind(bid, r.use_date, r.slot).all()).results?.[0];
          if (dup) { rejected.push({ code: r.code, reason: `이중예약 — 기존 ${dup.code}` }); continue; }
        }
        try { await db.prepare(`INSERT INTO reservations
            (code, branch_id, name, phone, use_date, slot, people_base, people_extra,
             base_amount, extra_amount, option_amount, total_amount,
             deposit_amount, deposit_status, balance_method, status, source, channel,
             request_note, cancel_reason, refund_type, canceled_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(code) DO UPDATE SET
             name=excluded.name, phone=excluded.phone, status=excluded.status,
             cancel_reason=excluded.cancel_reason, refund_type=excluded.refund_type,
             canceled_at=excluded.canceled_at, total_amount=excluded.total_amount,
             people_extra=excluded.people_extra, extra_amount=excluded.extra_amount,
             balance_method=excluded.balance_method`)
          .bind(r.code, bid, r.name || "", r.phone || "", r.use_date, r.slot,
            r.people_base | 0, r.people_extra | 0, r.base_amount | 0, r.extra_amount | 0,
            r.option_amount | 0, r.total_amount | 0, r.deposit_amount | 0,
            r.deposit_status || "waiting", r.balance_method || "", r.status,
            r.source || "manual", r.channel || "", r.request_note || "",
            r.cancel_reason || "", r.refund_type || "", r.canceled_at || null).run(); }
        catch (err){ rejected.push({ code: r.code, reason: "이중예약 — 슬롯 유니크 제약 (uq_res_slot)" }); continue; }
        const e = r.ext || {};
        await db.prepare(`INSERT INTO res_ext
            (code, quote_json, memos_json, int_issue, own_issue, checkin, noshow_at,
             refund_amount, refund_kind, cancel_tag, channel_no, batch_id, up)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(code) DO UPDATE SET
             quote_json=excluded.quote_json, memos_json=excluded.memos_json,
             int_issue=excluded.int_issue, own_issue=excluded.own_issue,
             checkin=excluded.checkin, noshow_at=excluded.noshow_at,
             refund_amount=excluded.refund_amount, refund_kind=excluded.refund_kind,
             cancel_tag=excluded.cancel_tag, channel_no=excluded.channel_no, up=excluded.up`)
          .bind(r.code, e.quote_json || null, e.memos_json || "[]", e.int_issue || "",
            e.own_issue || "", e.checkin ? 1 : 0, e.noshow_at || null,
            e.refund_amount ?? null, e.refund_kind || "", e.cancel_tag || "",
            e.channel_no || "", e.batch_id || "", now).run();
        if (r.log) await db.prepare(
          `INSERT INTO reservation_logs (reservation_id, actor, action, detail)
           SELECT id, ?, ?, ? FROM reservations WHERE code = ?`)
          .bind(actor || "대시보드", r.log.action || "update", r.log.detail || "", r.code).run();
      }

      /* ② 원장 — 추가만 */
      for (const l of (b.ledger || [])) {
        const rr = await db.prepare(
          `INSERT INTO ops_ledger (at, ref_id, kind, amount, memo, actor) VALUES (?,?,?,?,?,?)`)
          .bind(now, l.ref_id, l.kind, l.amount | 0, (l.memo || "").slice(0, 200), l.actor || actor).run();
        idMap.ledger[l.tmp] = "L" + rr.meta.last_row_id;
      }
      /* ③ 이벤트 — 추가만 */
      for (const ev of (b.events || [])) {
        const rr = await db.prepare(
          `INSERT INTO ops_events (at, type, ref_id, detail, actor) VALUES (?,?,?,?,?)`)
          .bind(now, ev.type, ev.ref_id || "", (ev.detail || "").slice(0, 300), ev.actor || actor).run();
        idMap.events[ev.tmp] = "E" + rr.meta.last_row_id;
      }
      /* ④ 분쟁 — 상태는 앞으로만 */
      const RANK = { PROPOSED: 1, DISPUTED: 2, WITHDRAWN: 3, CONFIRMED: 3 };
      for (const ic of (b.incidents || [])) {
        const cur = (await db.prepare(`SELECT state FROM ops_incidents WHERE id = ?`).bind(ic.id).all()).results?.[0];
        if (cur && RANK[ic.state] < RANK[cur.state]) continue;
        await db.prepare(`INSERT INTO ops_incidents
            (id, at, res_code, branch_code, kind, note, photos_json, amount, state, dispute_until, extra_json, actor, up)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(id) DO UPDATE SET state=excluded.state, extra_json=excluded.extra_json, up=excluded.up`)
          .bind(ic.id, ic.at || now, ic.res_code, ic.branch_code || "", ic.kind,
            (ic.note || "").slice(0, 300), ic.photos_json || "[]", ic.amount | 0,
            ic.state, ic.dispute_until || null, ic.extra_json || "{}", ic.actor || actor, now).run();
        idMap.incidents[ic.id] = ic.id;
      }
      /* ⑤ 대사함 */
      for (const qx of (b.recon || [])) {
        await db.prepare(`INSERT INTO ops_recon
            (id, at, kind, ref_id, branch_code, lock_key, note, src, state, extra_json, actor, up)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(id) DO UPDATE SET state=excluded.state, extra_json=excluded.extra_json, up=excluded.up`)
          .bind(qx.id, qx.at || now, qx.kind, qx.ref_id || "", qx.branch_code || "",
            qx.lock_key || "", (qx.note || "").slice(0, 300), qx.src || "",
            qx.state || "OPEN", qx.extra_json || "{}", qx.actor || actor, now).run();
        idMap.recon[qx.id] = qx.id;
      }
      /* ⑥ 잠금 · 지급 보류 */
      for (const lk of (b.locks || []))
        await db.prepare(`INSERT INTO ops_slot_locks (id, at, ids_json, up) VALUES (?,?,?,?)
            ON CONFLICT(id) DO UPDATE SET up=excluded.up`)
          .bind(lk.id, lk.at || now, lk.ids_json || "[]", now).run();
      for (const un of (b.unlocks || []))
        await db.prepare(`DELETE FROM ops_slot_locks WHERE id = ?`).bind(un).run();
      for (const [bc, held] of Object.entries(b.payHold || {}))
        await db.prepare(`INSERT INTO ops_pay_hold (branch_code, held, up) VALUES (?,?,?)
            ON CONFLICT(branch_code) DO UPDATE SET held=excluded.held, up=excluded.up`)
          .bind(bc, held ? 1 : 0, now).run();

      /* ⑦ 정책 — 마스터만 */
      if (b.settings) {
        if (role !== "master") rejected.push({ code: "policy", reason: "정책 저장은 마스터만 가능합니다 (9.7)" });
        else await writePolicy(db, b.settings, now);
      }
      /* ⑧ 고객 접점 실테이블 */
      idMap.cinq = {}; idMap.point = {}; idMap.order = {}; idMap.lead = {};
      for (const rv of (b.reviewUpd || [])) {
        /* 고객판(visibility)과 호스트판(hidden/report_status)을 함께 맞춥니다 */
        await db.prepare(`UPDATE reviews SET reply = ?, replied_at = ?, reply_updated_at = ?, visibility = ?, hidden = ? WHERE id = ?`)
          .bind(rv.reply || null, rv.replied_at || null, rv.replied_at || null,
            rv.visibility || "visible", rv.visibility === "hidden" ? 1 : 0, rv.id | 0).run();
        if (rv.visibility === "reported")
          await db.prepare(`UPDATE reviews SET report_status = 'requested' WHERE id = ?`).bind(rv.id | 0).run();
        else if (rv.visibility === "visible")
          await db.prepare(`UPDATE reviews SET report_status = 'none' WHERE id = ?`).bind(rv.id | 0).run();
      }
      for (const x of (b.cinqNew || [])) {
        const rr = await db.prepare(`INSERT INTO cust_inquiries (at, channel, name, phone, branch_code, subject, body, state, assignee, answer, up)
            VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
          .bind(x.at || now, x.channel || "전화", x.name || "", x.phone || "", x.branch_code || "",
            x.subject || "", (x.body || "").slice(0, 500), x.state || "대기", x.assignee || "", "", now).run();
        idMap.cinq[x.tmp] = "I" + rr.meta.last_row_id;
      }
      for (const x of (b.cinqUpd || []))
        await db.prepare(`UPDATE cust_inquiries SET state = ?, assignee = ?, answer = ?, closed_at = ?, up = ? WHERE id = ?`)
          .bind(x.state, x.assignee || "", x.answer || "", x.closed_at || null, now, x.id | 0).run();
      for (const x of (b.oinqUpd || []))
        await db.prepare(`UPDATE owner_inquiries SET status = ?, answer = ?, answered_at = datetime('now') WHERE id = ?`)
          .bind(x.status, x.answer || "", x.id | 0).run();
      for (const x of (b.pointNew || [])) {
        const rr = await db.prepare(`INSERT INTO cust_points (at, phone, name, kind, amount, memo, res_code, actor, up)
            VALUES (?,?,?,?,?,?,?,?,?)`)
          .bind(x.at || now, x.phone, x.name || "", x.kind, x.amount | 0, x.memo || "", x.res_code || "", x.actor || actor, now).run();
        idMap.point[x.tmp] = "T" + rr.meta.last_row_id;
      }
      for (const x of (b.orderNew || [])) {
        const rr = await db.prepare(`INSERT INTO partner_orders (at, res_code, branch_code, pkg_id, pkg_name, items_json, amount, state, up)
            VALUES (?,?,?,?,?,?,?,?,?)`)
          .bind(x.at || now, x.res_code, x.branch_code || "", x.pkg_id, x.pkg_name,
            x.items_json || "[]", x.amount | 0, x.state || "신규", now).run();
        idMap.order[x.tmp] = "O" + rr.meta.last_row_id;
      }
      for (const x of (b.orderUpd || []))
        await db.prepare(`UPDATE partner_orders SET state = ?, up = ? WHERE id = ?`)
          .bind(x.state, now, x.id | 0).run();
      for (const x of (b.leadNew || [])) {
        const rr = await db.prepare(`INSERT INTO franchise_leads (at, name, phone, region, memo, stage, up)
            VALUES (?,?,?,?,?,?,?)`)
          .bind(x.at || now, x.name, x.phone, x.region || "", x.memo || "", x.stage || "접수", now).run();
        idMap.lead[x.tmp] = "F" + rr.meta.last_row_id;
      }
      for (const x of (b.leadUpd || []))
        await db.prepare(`UPDATE franchise_leads SET stage = ?, memo = ?, up = ? WHERE id = ?`)
          .bind(x.stage, x.memo || "", now, x.id | 0).run();

      /* ⑨ 아직 실테이블 전이 아닌 저장소 — dash_kv 유지 */
      for (const [k, v] of Object.entries(b.kv || {}))
        await db.prepare(`INSERT INTO dash_kv (k, v, ts, by) VALUES (?,?,?,?)
            ON CONFLICT(k) DO UPDATE SET v=excluded.v, ts=excluded.ts, by=excluded.by`)
          .bind(k, String(v).slice(0, 200000), now, actor).run();

      return J({ ok: true, now, idMap, rejected });
    }

    return J({ ok: false, error: "op" }, 400);
  } catch (e) {
    return J({ ok: false, error: "서버 오류: " + (e && e.message || e) }, 500);
  }
}

function daysAgoStr(n) {
  const d = new Date(Date.now() - n * 864e5);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
