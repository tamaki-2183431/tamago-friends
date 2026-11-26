/**
 * 天気（実API）の純関数。DOM・DB 非依存。
 *
 * - Open-Meteo（キー不要・CORS可・無料枠）の `current=weather_code` だけを使う
 * - WMO コード → 4分類（はれ／くもり／あめ／ゆき）
 * - **実天気と偽らない**: 取得できなかったときは「さいごに とれた 天気」を
 *   `stale: true` で返し、1度も取れていなければ「くもり」を `stale: true` で返す
 */

import { findPrefecture } from '../../data/prefectures.js';

export const WEATHER_KINDS = Object.freeze(['sunny', 'cloudy', 'rain', 'snow']);

export const WEATHER_LABELS = Object.freeze({
  sunny: { label: 'はれ', icon: '☀️' },
  cloudy: { label: 'くもり', icon: '☁️' },
  rain: { label: 'あめ', icon: '🌧️' },
  snow: { label: 'ゆき', icon: '❄️' },
});

/** 取得の間隔（30分）と、これより古い値は「ふるい」とみなす */
export const WEATHER_TTL_MS = 30 * 60 * 1000;
export const WEATHER_STALE_MS = 60 * 60 * 1000;

export const OPEN_METEO_URL = 'https://api.open-meteo.com/v1/forecast';

/** WMO 天気コード → 4分類（null は「知らないコード」） */
export function classifyWmo(code) {
  if (code === null || code === undefined || code === '') return null;
  const value = Number(code);
  if (!Number.isFinite(value)) return null;
  if (value === 0 || value === 1) return 'sunny';
  if (value === 2 || value === 3 || value === 45 || value === 48) return 'cloudy';
  if ((value >= 51 && value <= 67) || (value >= 80 && value <= 82) || (value >= 95 && value <= 99)) return 'rain';
  if ((value >= 71 && value <= 77) || value === 85 || value === 86) return 'snow';
  return null;
}

/** 表示用のまとめ（保存値から） */
export function weatherView(weather, now = Date.now()) {
  const code = weather?.code;
  const kind = code === null || code === undefined ? null : classifyWmo(code);
  const fetchedAt = Number(weather?.fetchedAt) || 0;
  if (!kind) {
    // まだ一度も取れていない（未設定・オフライン・失敗）
    return { kind: 'cloudy', label: WEATHER_LABELS.cloudy.label, icon: WEATHER_LABELS.cloudy.icon, stale: true, fetchedAt, code: null };
  }
  const labels = WEATHER_LABELS[kind];
  return { kind, label: labels.label, icon: labels.icon, stale: !fetchedAt || now - fetchedAt > WEATHER_STALE_MS, fetchedAt, code };
}

/**
 * 部屋の天気の注記（実天気と偽らないための1行）。空文字は「出さない」。
 * ①地域が未設定 → 取得しない仕様なので、故障に見えないよう設定への案内を出す
 * ②設定済みで一度も取れていない ③取得済みだが古い
 */
export const WEATHER_NOTE_NO_PREFECTURE = 'せっていで すんでいる ところを えらぶと、そとの てんきが わかるよ';
export const WEATHER_NOTE_NEVER = 'まだ 天気が とれていないよ（あとで もういちど とるね）';
export const WEATHER_NOTE_STALE = 'まえに とれた 天気の まま ひょうじしているよ';

export function weatherNoteText(prefecture, view) {
  if (!prefecture) return WEATHER_NOTE_NO_PREFECTURE;
  if (!view?.stale) return '';
  return view.code === null ? WEATHER_NOTE_NEVER : WEATHER_NOTE_STALE;
}

/** 取得URL（緯度経度は2桁に丸める） */
export function weatherUrl(prefecture) {
  const lat = Number(prefecture?.lat);
  const lon = Number(prefecture?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return `${OPEN_METEO_URL}?latitude=${lat.toFixed(2)}&longitude=${lon.toFixed(2)}&current=weather_code`;
}

/**
 * 天気を取りに行く（失敗しても投げない）。
 * @returns {Promise<{ok:boolean, code?:number, kind?:string, fetchedAt?:number, reason?:string}>}
 */
export async function fetchWeather(prefectureId, {
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  timeoutMs = 6000,
} = {}) {
  const prefecture = findPrefecture(prefectureId);
  const url = weatherUrl(prefecture);
  if (!url) return { ok: false, reason: 'no-prefecture' };
  if (typeof fetchImpl !== 'function') return { ok: false, reason: 'no-fetch' };

  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const response = await fetchImpl(url, controller ? { signal: controller.signal } : {});
    if (!response?.ok) return { ok: false, reason: `http-${response?.status ?? 'error'}` };
    const data = await response.json();
    const raw = data?.current?.weather_code ?? data?.current_weather?.weathercode ?? null;
    const code = Number(raw);
    const kind = classifyWmo(code);
    if (!kind) return { ok: false, reason: 'unknown-code' };
    return { ok: true, code, kind, fetchedAt: now() };
  } catch (error) {
    return { ok: false, reason: error?.name === 'AbortError' ? 'timeout' : 'network' };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
