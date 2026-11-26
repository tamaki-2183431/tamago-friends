/**
 * 就寝・起床の自動化と夜間ロック（v25）の純関数。
 * DOM / IndexedDB / Date.now() に依存しない（時刻はすべて引数で受け取る）ので、
 * 単体テストと E2E の時計送り（page.clock）で同じ関数を通せる。
 *
 * 仕様
 * - 22:00〜06:59 を「ねる じかん」。判定は**端末の実時刻**（既存の時間帯表示＝periodFor と同じ）。
 *   曜日・休日の例外は無い。
 * - 22:00 に全ペットを就寝（`sleeping=true` / `sleepingSince` は**就寝時刻**）、7:00 に全員起床。
 * - 境界の1回だけを見分ける（prev と now の比較）。22 時台に何度判定しても二重に就寝しない。
 * - 22 時前に手動で寝かせた子は `sleepingSince` を維持したまま 7 時に起きる。
 * - 保存は既存フィールドのみ（`sleeping` / `sleepingSince`）。形式の変更はしない。
 */

/** 「ねる じかん」の始まり（時） */
export const NIGHT_START_HOUR = 22;
/** 「ねる じかん」の終わり（時）。この時刻から おきる */
export const NIGHT_END_HOUR = 7;

/**
 * 画面（子画面）が実時刻へ同期する間隔。
 * 22:00 の就寝も 7:00 の起床も**この1本のタイマー**で効く（境界のトーストは1回だけ）。
 * v28: 60秒 → 15秒（起床の遅れを最大15秒に）。IDB読み1回＋比較だけなので負荷は軽微。
 */
export const NIGHT_SYNC_INTERVAL_MS = 15 * 1000;

/** 22:00 の合図（トースト） */
export const NIGHT_REST_TOAST = 'みんな ねる じかん だよ';
/** 7:00 の合図（トースト） */
export const MORNING_TOAST = 'おはよう！ おきたよ';
/** 夜間に おせわ（ごはん・あそぶ・なでる・おふろ・ねかせる/おこす）を押したとき */
export const NIGHT_CARE_TEXT = 'いまは ねる じかん だよ（あさ 7じに おきるよ）';
/** 夜間に ゲームを押したとき（Phase 3-3 で使う） */
export const NIGHT_GAME_TEXT = 'あさ 7じから あそべるよ';

/** ローカル時刻の「時」（不正値は null） */
function hourOf(now) {
  const value = Number(now);
  if (!Number.isFinite(value)) return null;
  return new Date(value).getHours();
}

function startOfDayAt(now, hour) {
  const date = new Date(Number(now));
  if (!Number.isFinite(date.getTime())) return Number(now) || 0;
  const at = new Date(date.getTime());
  at.setHours(hour, 0, 0, 0);
  return at.getTime();
}

/**
 * いまが「ねる じかん」（22:00〜06:59）か。
 * @param {number} now 端末の実時刻（ms）
 */
export function isNightRest(now = Date.now()) {
  const hour = hourOf(now);
  if (hour === null) return false;
  return hour >= NIGHT_START_HOUR || hour < NIGHT_END_HOUR;
}

/**
 * いまが夜なら「その夜の始まり」＝直近の 22:00（ms）。
 * 0〜6 時台は前日の 22:00。夜でないときは当日の 22:00（＝これから来る夜）を返す。
 * @param {number} now
 */
export function nightRestStartFor(now = Date.now()) {
  const start = startOfDayAt(now, NIGHT_START_HOUR);
  const hour = hourOf(now);
  if (hour === null) return start;
  if (hour < NIGHT_END_HOUR) {
    const previous = new Date(start);
    previous.setDate(previous.getDate() - 1);
    return previous.getTime();
  }
  return start;
}

/**
 * 直近の 7:00（ms）。夜でないとき（7:00 以降）は当日 7:00、0〜6 時台は前日 7:00。
 * **昼間に手動で寝かせた子を起こさない**ための境目に使う。
 * @param {number} now
 */
export function lastMorningStartFor(now = Date.now()) {
  const morning = startOfDayAt(now, NIGHT_END_HOUR);
  const hour = hourOf(now);
  if (hour === null) return morning;
  if (hour < NIGHT_END_HOUR) {
    const previous = new Date(morning);
    previous.setDate(previous.getDate() - 1);
    return previous.getTime();
  }
  return morning;
}

/** いまの夜の終わり＝次の 7:00（ms）。夜でないときは明日の 7:00 */
export function nightRestEndFor(now = Date.now()) {
  const end = startOfDayAt(now, NIGHT_END_HOUR);
  const hour = hourOf(now);
  if (hour === null) return end;
  if (hour >= NIGHT_END_HOUR) {
    const next = new Date(end);
    next.setDate(next.getDate() + 1);
    return next.getTime();
  }
  return end;
}

/**
 * 起動時に「閉じていた夜」の たいりょく 回復を何時間ぶん数えるか（純関数）。
 *
 * アプリを閉じている間に 22:00〜7:00 を跨いだ場合、その子は夜のあいだ寝ていた扱いにする
 * （仕様: 回復は既存の SLEEP_RECOVERY_PER_HOUR=20。22→7 で満タン）。
 * - 昼（7:00〜21:59）に起動したときだけ対象。夜に起動したときは、そのまま寝かせて
 *   通常の「閉じていた分の回復」に任せる。
 * - `sleeping` の子は既存の resume 回復が数えるので対象外（二重に数えない）。
 * - 直近の夜（前日22:00〜当日7:00）だけ。何日も閉じていても 1 晩で満タンになる。
 *
 * @returns {{from:number, to:number, ms:number}|null}
 */
export function nightRecoveryWindow(pet, now = Date.now()) {
  if (isNightRest(now)) return null;
  if (pet?.sleeping === true) return null;
  const morning = lastMorningStartFor(now);
  const last = Number(pet?.lastTickAt) || 0;
  if (last >= morning) return null; // 7:00 以降に一度動いている＝夜を跨いでいない
  const nightStart = nightRestStartFor(morning - 1); // 前日 22:00
  const from = Math.max(last, nightStart);
  const to = Math.min(Number(now), morning);
  if (!(to > from)) return null;
  return { from, to, ms: to - from };
}

/**
 * 実時刻に合わせて全ペットの就寝・起床をそろえる（**境界の1回判定つき**）。
 *
 * - `prev` は前回の判定時刻（アプリを開いている間の1分ごとの判定）。
 *   `prev=null`（起動時・リロード）は「境界を跨いだか分からない」ので、状態は実時刻に合わせるが
 *   `entered` / `left` は false（＝トーストは出さない）。
 * - 22:00 の就寝では `sleepingSince` を**その夜の 22:00**にする（起動が 22:30 でも同じ）。
 *   22 時前に手動で寝かせた子（`sleeping=true` が先）は `sleepingSince` を書き換えない。
 * - `lastTickAt` は「22:00 より後」に丸める（閉じていた分の たいりょく 回復を、
 *   夜の始まりからだけ数えるため。二重に回復させない）。
 *
 * @param {Array<object>} pets
 * @param {number} now
 * @param {number|null} prev
 * @returns {{pets:Array<object>, changed:boolean, night:boolean, entered:boolean, left:boolean, startAt:number|null, updates:Array<object>}}
 */
export function applyNightRest(pets = [], now = Date.now(), prev = null) {
  const night = isNightRest(now);
  const prevNight = prev === null || prev === undefined ? null : isNightRest(prev);
  const entered = prevNight === false && night === true;
  const left = prevNight === true && night === false;
  const startAt = night ? nightRestStartFor(now) : null;
  const nowValue = Number(now);
  const updates = [];

  const next = pets.map((pet) => {
    if (!pet) return pet;
    const alreadyAsleep = pet.sleeping === true;
    const since = Number(pet.sleepingSince);
    const hasSince = Number.isFinite(since);

    if (night) {
      // すでに寝ている（22時前の手動就寝を含む）→ そのまま。sleepingSince だけ欠けていれば補う
      if (alreadyAsleep && hasSince) return pet;
      const lastTickAt = alreadyAsleep
        ? pet.lastTickAt
        : Math.min(nowValue, Math.max(Number(pet.lastTickAt) || 0, startAt ?? 0));
      const updated = {
        ...pet,
        sleeping: true,
        sleepingSince: alreadyAsleep && hasSince ? pet.sleepingSince : startAt,
        lastTickAt,
      };
      updates.push(updated);
      return updated;
    }

    if (!alreadyAsleep) return pet;
    // 昼間の起床は「夜に寝た子」だけ。昼間に手動で寝かせた子（7:00 より後に寝た子）は
    // 従来どおり おこす まで寝たまま（v25 で昼の手動就寝の意味を変えない）。
    if (hasSince && since > lastMorningStartFor(now)) return pet;
    const updated = { ...pet, sleeping: false, sleepingSince: null, lastTickAt: now };
    updates.push(updated);
    return updated;
  });

  return { pets: next, changed: updates.length > 0, night, entered, left, startAt, updates };
}
