/**
 * Reconstructed from the real captured stdout of `claude setup-token` (Claude Code
 * v2.1.283, macOS), captured by Matías 2026-11-12 with:
 *   claude setup-token | sed -E 's/sk-ant-[A-Za-z0-9_-]+/<TOKEN>/g' | cat -vet
 * The real token is replaced here by `FAKE_TOKEN` below, and the OAuth URL's
 * session-specific query parameters are replaced by placeholders — everything else
 * (the repeated banner, the OSC 8 hyperlink framing, the paste prompt, the success
 * text) matches the real capture, including its real ESC (`\x1b`) and BEL (`\x07`)
 * bytes.
 */
const ESC = "\x1b";
const BEL = "\x07";

export const FAKE_TOKEN = "sk-ant-FAKE1234567890abcdefGHIJKLMNOPQRSTUVWXYZ";

const BANNER =
  "Welcome to Claude Code v2.1.283\n\n" +
  " This will guide you through long-lived (1-year) auth token setup for your Claude account. Claude subscription required.\n";

const FAKE_URL =
  "https://claude.com/cai/oauth/authorize?code=true&client_id=FAKE-CLIENT-ID" +
  "&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback" +
  "&scope=user%3Ainference&code_challenge=FAKE-CHALLENGE&code_challenge_method=S256&state=FAKE-STATE";

const HYPERLINK = `${ESC}]8;id=fakeid;${FAKE_URL}${BEL}${FAKE_URL}${ESC}]8;;${BEL}`;

export const SETUP_TOKEN_OUTPUT_FIXTURE =
  `${ESC}[?2004h${ESC}[?2031h${ESC}[?1004h${BANNER}\n` +
  `${BANNER}\n` +
  " Browser didn't open? Use the url below to sign in (c to copy)\n\n" +
  `${HYPERLINK}\n` +
  ` Paste code here if prompted >${BANNER}\n\n` +
  " ✓ Long-lived authentication token created successfully!\n\n" +
  " Your OAuth token (valid for 1 year):\n\n" +
  ` ${FAKE_TOKEN}\n\n` +
  " Store this token securely. You won't be able to see it again.\n\n" +
  " Use this token by setting: export CLAUDE_CODE_OAUTH_TOKEN=<token>\n" +
  `${ESC}[>4m${ESC}[<u${ESC}[?1004l${ESC}[?2031l${ESC}[?2004l`;
