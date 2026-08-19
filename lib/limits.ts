/**
 * Serverless cắt ngang function khi hết giờ. Next bắt `maxDuration` phải là số
 * viết thẳng trong route nên không gom vào một chỗ được — bù lại mỗi route
 * truyền chính con số đó vào đây, hai bên không thể lệch nhau.
 */

/** Chừa lại một khoảng để đóng browser và trả response trước khi bị chém. */
const RESERVE_SECONDS = 30;

export function deadlineFrom(startedAt: number, maxDurationSeconds: number) {
  return startedAt + Math.max(maxDurationSeconds - RESERVE_SECONDS, 30) * 1000;
}
