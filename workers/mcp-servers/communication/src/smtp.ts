/**
 * A minimal SMTP client built on Cloudflare Workers' native TCP sockets
 * API (`cloudflare:sockets`). This is what lets communication-mcp send
 * real mail without a proprietary HTTP-API email service in the loop —
 * `nodemailer` (the obvious open-source choice) doesn't run in Workers
 * because it depends on Node's `net.Socket` implementation directly
 * rather than a fetch-like or Workers-native transport, so this
 * implements just enough of RFC 5321 by hand instead.
 *
 * Works with ANY SMTP server that accepts implicit TLS on port 465 with
 * AUTH LOGIN — a self-hosted Postfix container (see docker-compose.yml's
 * commented-out `smtp` service), or a free-tier relay from providers like
 * Brevo/Mailjet if you'd rather not run your own mail server (running
 * your own gets your sending IP blocklisted fast without a lot of
 * deliverability work — see docs/06-oss-free-stack.md's honest take on
 * this).
 *
 * Deliberately NOT implemented, to keep this reviewable: STARTTLS on 587
 * (use implicit TLS on 465 instead), multiple recipients in one call,
 * attachments, connection pooling/reuse, and DSN/bounce parsing. Good
 * enough for the outreach volumes docs/04's MVP scope describes; revisit
 * if you outgrow it.
 */
import { connect } from "cloudflare:sockets";

export interface SmtpConfig {
  host: string;
  port: number; // 465 (implicit TLS) is what this client speaks
  username: string;
  password: string;
  /** Used in the EHLO greeting — doesn't need to be a real domain, but
   *  some servers are picky about it not being empty/localhost. */
  ehloDomain: string;
}

export interface SmtpMessage {
  from: string;
  to: string;
  subject: string;
  html: string;
  text: string;
  extraHeaders?: Record<string, string>;
}

class SmtpProtocolError extends Error {}

/** Reads one SMTP response (possibly multi-line, e.g. EHLO's capability
 *  list) off the socket and returns its final status line. */
class SmtpLineReader {
  private buffer = "";
  private decoder = new TextDecoder();

  constructor(private reader: ReadableStreamDefaultReader<Uint8Array>) {}

  async readResponse(): Promise<string> {
    for (;;) {
      const lineEnd = this.buffer.indexOf("\r\n");
      if (lineEnd === -1) {
        const { value, done } = await this.reader.read();
        if (done) throw new SmtpProtocolError("connection closed while waiting for a response");
        this.buffer += this.decoder.decode(value, { stream: true });
        continue;
      }
      const line = this.buffer.slice(0, lineEnd);
      this.buffer = this.buffer.slice(lineEnd + 2);
      // "250-foo" = more lines follow; "250 foo" (space, not hyphen, in
      // position 3) = this is the last line of the response.
      if (line.length >= 4 && line[3] === " ") return line;
      if (line.length >= 4 && line[3] === "-") continue;
      // Malformed/short line — treat as terminal rather than looping forever.
      return line;
    }
  }
}

function assertCode(response: string, expectedFirstDigit: string, context: string) {
  if (!response.startsWith(expectedFirstDigit)) {
    throw new SmtpProtocolError(`unexpected response during ${context}: ${response}`);
  }
}

/** RFC 5321 dot-stuffing: any line starting with "." gets a second "."
 *  prepended, or the lone "." on its own line would be misread as the
 *  end-of-DATA marker. */
function dotStuff(body: string): string {
  return body.replace(/\r\n\./g, "\r\n..");
}

export async function sendSmtpMail(config: SmtpConfig, message: SmtpMessage): Promise<void> {
  const socket = connect({ hostname: config.host, port: config.port }, { secureTransport: "on" });
  const writer = socket.writable.getWriter();
  const reader = socket.readable.getReader();
  const lineReader = new SmtpLineReader(reader);
  const encoder = new TextEncoder();

  const send = (data: string) => writer.write(encoder.encode(data + "\r\n"));

  try {
    assertCode(await lineReader.readResponse(), "2", "connection greeting");

    await send(`EHLO ${config.ehloDomain}`);
    assertCode(await lineReader.readResponse(), "2", "EHLO");

    await send("AUTH LOGIN");
    assertCode(await lineReader.readResponse(), "3", "AUTH LOGIN prompt");

    await send(btoa(config.username));
    assertCode(await lineReader.readResponse(), "3", "AUTH username");

    await send(btoa(config.password));
    assertCode(await lineReader.readResponse(), "2", "AUTH password (check credentials if this fails)");

    await send(`MAIL FROM:<${message.from}>`);
    assertCode(await lineReader.readResponse(), "2", "MAIL FROM");

    await send(`RCPT TO:<${message.to}>`);
    assertCode(await lineReader.readResponse(), "2", "RCPT TO");

    await send("DATA");
    assertCode(await lineReader.readResponse(), "3", "DATA");

    const boundary = `factory-${crypto.randomUUID()}`;
    const headers = [
      `From: ${message.from}`,
      `To: ${message.to}`,
      `Subject: ${message.subject}`,
      `MIME-Version: 1.0`,
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      ...Object.entries(message.extraHeaders ?? {}).map(([k, v]) => `${k}: ${v}`),
    ].join("\r\n");

    const body = [
      `--${boundary}`,
      `Content-Type: text/plain; charset=utf-8`,
      ``,
      message.text,
      `--${boundary}`,
      `Content-Type: text/html; charset=utf-8`,
      ``,
      message.html,
      `--${boundary}--`,
    ].join("\r\n");

    const fullMessage = dotStuff(`${headers}\r\n\r\n${body}`);
    await send(`${fullMessage}\r\n.`);
    assertCode(await lineReader.readResponse(), "2", "end of DATA (message accepted)");

    await send("QUIT");
  } finally {
    writer.releaseLock();
    reader.releaseLock();
    await socket.close().catch(() => {});
  }
}
