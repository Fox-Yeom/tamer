// How a failed turn failed, in Korean (#53) — the kind only, never the error text (URLs, request
// ids). Codex: `codex_error_info` ("server_overloaded", "http_connection_failed 401"); Claude: its
// StopFailure `error` (rate_limit, overloaded …). Unknown kinds: nothing (just "실패").
// Shared by the main window and the overlay.
const KINDS = {
  // Codex
  context_window_exceeded: "컨텍스트 초과", session_budget_exceeded: "세션 예산 초과", usage_limit_exceeded: "사용 한도",
  rate_limit_exceeded: "속도 제한", flex_unavailable: "요청 처리 불가", server_overloaded: "서버 과부하",
  cyber_policy: "정책 차단", bio_policy: "정책 차단", misalignment_policy_violation: "정책 차단", too_many_denials: "거절이 너무 많음",
  http_connection_failed: "연결 실패", response_stream_connection_failed: "응답 연결 실패", response_stream_disconnected: "응답 끊김",
  response_too_many_failed_attempts: "재시도 실패", internal_server_error: "서버 오류", unauthorized: "인증 실패",
  bad_request: "잘못된 요청", invalid_prompt: "잘못된 프롬프트", sandbox_error: "샌드박스 오류", other: "기타 오류",
  // Claude Code (StopFailure)
  rate_limit: "속도 제한", overloaded: "서버 과부하", server_error: "서버 오류", authentication_failed: "인증 실패",
  billing_error: "결제 문제", invalid_request: "잘못된 요청", max_output_tokens: "출력 한도", unknown: "알 수 없는 오류",
};

// "http_connection_failed 401" → "연결 실패(401)"; null when the kind isn't known
export function failLabel(kind) {
  const [k, code] = String(kind || "").split(" ");
  const label = KINDS[k];
  return label ? `${label}${/^\d{3}$/.test(code || "") ? `(${code})` : ""}` : null;
}
