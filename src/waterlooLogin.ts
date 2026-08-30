/**
 * Optional UWaterloo WatIAM + Duo sign-in.
 *
 * Brightspace itself delegates to UWaterloo ADFS and Duo, so reproducing the exchange with raw
 * HTTP would mean reimplementing a JavaScript SAML client. A short-lived headless browser is
 * both less brittle and closer to what the user already does. The browser is closed after every
 * attempt; only the final learn.uwaterloo.ca cookies leave this module.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import chromium from "@sparticuz/chromium";
import puppeteer, { type Browser, type Frame, type Page } from "puppeteer-core";
import type { WaterlooCredentials } from "./config.js";
import { validateCookie } from "./setup.js";

const WATERLOO_LEARN_HOST = "learn.uwaterloo.ca";
/**
 * The whole sign-in, Duo included. This is a human-paced wait: someone has to notice the
 * code, unlock a phone and type it, so it is generous. It stays under the 300s function
 * ceiling in vercel.json with room for the session check that follows.
 */
const DEFAULT_TIMEOUT_MS = 240_000;

/** How often to re-announce a pending Duo approval. Comfortably inside a 60s client idle window. */
const HEARTBEAT_INTERVAL_MS = 20_000;

export type WaterlooLoginFailure =
  | "invalid_credentials"
  | "duo_denied"
  | "duo_timeout"
  | "login_timeout"
  | "browser_unavailable"
  | "session_rejected";

export class WaterlooLoginError extends Error {
  constructor(
    readonly code: WaterlooLoginFailure,
    message: string,
  ) {
    super(message);
    this.name = "WaterlooLoginError";
  }
}

export interface WaterlooLoginResult {
  cookie: string;
  duoPrompted: boolean;
}

export type WaterlooLoginEvent =
  | { type: "duo_verification_code"; code: string }
  /**
   * Emitted every HEARTBEAT_INTERVAL_MS while the Duo push is outstanding.
   *
   * Not cosmetic. MCP clients abort a tool call that goes quiet, and each progress
   * notification resets that idle clock — so without these the call is killed long before a
   * human finds their phone, however generous DEFAULT_TIMEOUT_MS is.
   */
  | { type: "duo_waiting"; code: string; secondsWaiting: number };

export type WaterlooLoginEventHandler = (
  event: WaterlooLoginEvent,
) => void | Promise<void>;

export type DuoPageAction =
  | "duo_push"
  | "other_options"
  | "decline_trust"
  | "complete_trust"
  | "continue_after_approval";

interface FrameState {
  url: string;
  text: string;
  controls: string[];
}

export interface DuoActionDecision {
  action: DuoPageAction;
  label: string;
}

/** Keep simultaneous calls on one warm instance from sending duplicate Duo pushes. */
let inFlight: Promise<WaterlooLoginResult> | null = null;
let lastClickDiagnostic = "";

export function signInUWaterloo(
  credentials: WaterlooCredentials,
  host: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  onEvent?: WaterlooLoginEventHandler,
): Promise<WaterlooLoginResult> {
  if (!inFlight) {
    inFlight = performSignIn(credentials, host, timeoutMs, onEvent).finally(() => {
      inFlight = null;
    });
  }
  return inFlight;
}

async function performSignIn(
  credentials: WaterlooCredentials,
  host: string,
  timeoutMs: number,
  onEvent?: WaterlooLoginEventHandler,
): Promise<WaterlooLoginResult> {
  const hostname = new URL(host).hostname.toLowerCase();
  if (hostname !== WATERLOO_LEARN_HOST) {
    throw new WaterlooLoginError(
      "browser_unavailable",
      `Automatic sign-in currently supports https://${WATERLOO_LEARN_HOST} only. ` +
        "The existing D2L_COOKIE setup still works for every institution.",
    );
  }

  let browser: Browser | undefined;
  let page: Page | undefined;
  let stage = "launch_browser";
  try {
    browser = await launchBrowser();
    page = await browser.newPage();
    page.setDefaultNavigationTimeout(30_000);
    page.setDefaultTimeout(30_000);

    stage = "open_learn_login";
    await page.goto(`${host}/d2l/login`, { waitUntil: "domcontentloaded" });
    stage = "wait_for_username";
    await page.waitForSelector("#userNameInput", { visible: true });

    const username = credentials.username.includes("@")
      ? credentials.username
      : `${credentials.username}@uwaterloo.ca`;
    stage = "enter_username";
    await replaceInput(page, "#userNameInput", username);

    const passwordVisible = await page
      .$eval("#passwordInput", (element) => {
        const input = element as HTMLInputElement;
        const style = getComputedStyle(input);
        return style.display !== "none" && style.visibility !== "hidden" && input.offsetParent !== null;
      })
      .catch(() => false);
    if (!passwordVisible) {
      stage = "advance_to_password";
      await page.click("#nextButton");
      await page.waitForSelector("#passwordInput", { visible: true });
    }

    stage = "submit_credentials";
    await replaceInput(page, "#passwordInput", credentials.password);
    await page.click("#submitButton");

    stage = "wait_for_duo_or_learn";
    return await waitForSession(
      page,
      host,
      timeoutMs,
      (nextStage) => {
        stage = nextStage;
      },
      onEvent,
    );
  } catch (error) {
    const location = page ? safePageLocation(page) : "browser-not-open";
    if (error instanceof WaterlooLoginError) {
      console.warn("[waterloo-login] sign-in stopped", {
        code: error.code,
        stage,
        location,
      });
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    console.error("[waterloo-login] browser failure", {
      stage,
      location,
      error: message,
    });
    const unavailable = /executable|browser process|failed to launch|could not find chrome/i.test(message);
    throw new WaterlooLoginError(
      unavailable ? "browser_unavailable" : "login_timeout",
      unavailable
        ? "The server could not start its private sign-in browser. Manual D2L_COOKIE setup is still available."
        : "UWaterloo sign-in did not finish. No existing D2L session was changed.",
    );
  } finally {
    await browser?.close().catch(() => undefined);
  }
}

async function launchBrowser(): Promise<Browser> {
  const systemChrome = findSystemChrome();
  const useServerlessChromium = process.platform === "linux" && !systemChrome;
  const executablePath = useServerlessChromium
    ? await chromium.executablePath()
    : systemChrome;

  if (!executablePath) {
    throw new WaterlooLoginError(
      "browser_unavailable",
      "No Chrome/Chromium executable is available on this host. Manual D2L_COOKIE setup is unchanged.",
    );
  }

  const headless = useServerlessChromium ? "shell" : true;
  const args = useServerlessChromium
    ? await puppeteer.defaultArgs({ args: chromium.args, headless })
    : ["--disable-dev-shm-usage"];

  return puppeteer.launch({
    args,
    executablePath,
    headless,
    defaultViewport: { width: 1280, height: 900, deviceScaleFactor: 1 },
  });
}

function findSystemChrome(): string | undefined {
  const configured = process.env.PUPPETEER_EXECUTABLE_PATH?.trim();
  const candidates = [
    configured,
    process.platform === "win32"
      ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
      : undefined,
    process.platform === "win32"
      ? "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe"
      : undefined,
    process.platform === "win32" && process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe")
      : undefined,
    process.platform === "darwin"
      ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
      : undefined,
    process.platform === "linux" ? "/usr/bin/google-chrome" : undefined,
    process.platform === "linux" ? "/usr/bin/google-chrome-stable" : undefined,
    process.platform === "linux" ? "/usr/bin/chromium" : undefined,
    process.platform === "linux" ? "/usr/bin/chromium-browser" : undefined,
  ];
  return candidates.find((candidate): candidate is string => !!candidate && existsSync(candidate));
}

async function replaceInput(page: Page, selector: string, value: string): Promise<void> {
  await page.$eval(selector, (element) => {
    const input = element as HTMLInputElement;
    input.value = "";
  });
  await page.type(selector, value);
}

async function waitForSession(
  page: Page,
  host: string,
  timeoutMs: number,
  setStage: (stage: string) => void,
  onEvent?: WaterlooLoginEventHandler,
): Promise<WaterlooLoginResult> {
  const deadline = Date.now() + timeoutMs;
  const completedActions = new Set<string>();
  let duoPrompted = false;
  let emittedVerificationCode: string | undefined;
  let codeEmittedAt = 0;
  let lastHeartbeatAt = 0;
  let lastDebugState = "";
  let lastLocation = "";

  while (Date.now() < deadline) {
    const location = safePageLocation(page);
    if (location !== lastLocation) {
      lastLocation = location;
      console.info("[waterloo-login] navigation", { location });
    }

    const cookie = await learnCookie(page, host);
    if (cookie) {
      setStage("learn_session_received");
      console.info("[waterloo-login] Learn session received", { duoPrompted });
      return { cookie, duoPrompted };
    }

    const frames = page.frames();
    const states = await Promise.all(frames.map((frame) => frameState(frame)));
    const combined = states.map((state) => state.text).join("\n").toLowerCase();

    const verificationCode = states
      .map((state) => extractDuoVerificationCode(state))
      .find((code): code is string => !!code);
    // Duo animates/re-renders this screen and can leave other three-digit values in its
    // accessibility text. The first complete verification code belongs to this push; never
    // replace it during the same attempt.
    if (verificationCode && !emittedVerificationCode) {
      emittedVerificationCode = verificationCode;
      codeEmittedAt = Date.now();
      lastHeartbeatAt = Date.now();
      duoPrompted = true;
      setStage("wait_for_duo_code_entry");
      if (onEvent) {
        try {
          await onEvent({ type: "duo_verification_code", code: verificationCode });
        } catch (error) {
          console.warn("[waterloo-login] could not deliver Duo verification code", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    if (emittedVerificationCode && process.env.UWATERLOO_LOGIN_DEBUG === "1") {
      const debugState = states
        .filter((state) => /duo|duosecurity/i.test(`${state.url}\n${state.text}`))
        .map((state) => ({
          text: state.text
            .replace(/\b\d{3}\b/g, "***")
            .replace(/\s+/g, " ")
            .slice(0, 1_000),
          controls: state.controls,
        }));
      const serialized = JSON.stringify(debugState);
      if (serialized !== lastDebugState) {
        lastDebugState = serialized;
        console.info("[waterloo-login] Duo state", debugState);
      }
    }
    if (
      /incorrect (user id|username|password)|invalid (user id|username|password)|we can't sign you in/.test(
        combined,
      )
    ) {
      throw new WaterlooLoginError(
        "invalid_credentials",
        "UWaterloo rejected the configured username or password. The existing D2L session was not changed.",
      );
    }

    if (
      /login denied|request (?:was )?denied|you denied|authentication denied|duo push (?:was )?denied|verification (?:was )?denied/.test(
        combined,
      )
    ) {
      throw new WaterlooLoginError(
        "duo_denied",
        "The Duo request was denied. The existing D2L session was not changed.",
      );
    }
    if (/duo push (?:timed out|expired)|request expired|authentication timed out|verification timed out/.test(combined)) {
      throw new WaterlooLoginError(
        "duo_timeout",
        "The Duo request expired before approval. Run sign-in again when the phone is " +
          "available. If no three-digit code ever appeared, this client is not showing the " +
          "server's progress messages — sign in at /setup instead, which shows the code on " +
          "the page itself.",
      );
    }

    if (states.some(duoPushIsPending)) {
      duoPrompted = true;
      setStage("wait_for_duo_approval");
    }

    const decisions = states
      .map((state, index) => ({ state, frame: frames[index], decision: decideDuoAction(state) }))
      .filter(
        (entry): entry is { state: FrameState; frame: Frame; decision: DuoActionDecision } =>
          !!entry.frame && !!entry.decision,
      )
      .sort((a, b) => actionPriority(a.decision.action) - actionPriority(b.decision.action));

    for (const { state, frame, decision } of decisions) {
      const actionKey = `${decision.action}:${normalizeLabel(decision.label)}`;
      if (completedActions.has(actionKey)) continue;

      if (process.env.UWATERLOO_LOGIN_DEBUG === "1") {
        console.info("[waterloo-login] Duo decision", decision);
      }

      // A remembered passkey/security-key preference can open a native browser prompt. Escape
      // closes it so the Universal Prompt's "Other options" control is usable.
      if (
        decision.action === "other_options" &&
        /passkey|security key|touch id|windows hello/i.test(state.text)
      ) {
        await page.keyboard.press("Escape").catch(() => undefined);
      }

      const clicked = await clickControl(frame, decision.label);
      if (!clicked) continue;

      completedActions.add(actionKey);
      setStage(decision.action);
      console.info("[waterloo-login] handled Duo page", { action: decision.action });
      if (decision.action === "duo_push") duoPrompted = true;
      break;
    }

    // Keep the client's idle timer alive for as long as the push is genuinely outstanding.
    if (onEvent && emittedVerificationCode && Date.now() - lastHeartbeatAt >= HEARTBEAT_INTERVAL_MS) {
      lastHeartbeatAt = Date.now();
      try {
        await onEvent({
          type: "duo_waiting",
          code: emittedVerificationCode,
          secondsWaiting: Math.round((Date.now() - codeEmittedAt) / 1000),
        });
      } catch (error) {
        console.warn("[waterloo-login] could not deliver Duo heartbeat", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    await delay(500);
  }

  throw new WaterlooLoginError(
    duoPrompted ? "duo_timeout" : "login_timeout",
    duoPrompted
      ? "Duo approval was not completed before the sign-in window ended. Run the tool again " +
        "when the phone is available. If no three-digit code ever appeared, this client is " +
        "not showing the server's progress messages — sign in at /setup instead, which " +
        "shows the code on the page itself."
      : "UWaterloo sign-in did not reach Duo or Learn before the sign-in window ended.",
  );
}

async function learnCookie(page: Page, host: string): Promise<string | null> {
  const cookies = await page.browserContext().cookies();
  const relevant = cookies
    .filter((cookie) => cookie.domain.replace(/^\./, "").endsWith(WATERLOO_LEARN_HOST))
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join("; ");
  const validated = validateCookie(relevant);
  return validated.ok ? validated.cookie : null;
}

async function frameState(frame: Frame): Promise<FrameState> {
  const url = frame.url();
  return frame
    .evaluate(() => ({
      text: (document.body?.innerText ?? "").slice(0, 20_000),
      controls: Array.from(
        document.querySelectorAll<HTMLElement>(
          "button, input[type='button'], input[type='submit'], [role='button'], a",
        ),
      )
        .filter(
          (element) =>
            element.offsetParent !== null && element.getAttribute("aria-disabled") !== "true",
        )
        .map(
          (element) =>
            element.innerText ||
            (element as HTMLInputElement).value ||
            element.getAttribute("aria-label") ||
            "",
        ),
    }))
    .then((state) => ({ url, ...state }))
    .catch(() => ({ url, text: "", controls: [] }));
}

/**
 * Chooses one safe transition from a Duo page snapshot.
 *
 * Universal Prompt remembers the last factor per user. A fresh browser can therefore land on
 * push, passcode, or a native passkey prompt even though it has no browser history of its own.
 */
export function decideDuoAction(state: FrameState): DuoActionDecision | null {
  const locationAndText = `${state.url}\n${state.text}`;
  if (!/duo|duosecurity/i.test(locationAndText)) return null;

  const controls = state.controls.map((label) => ({ label, normalized: normalizeLabel(label) }));
  const trustScreen =
    /trust (?:this|the) browser|remember (?:this|the) (?:browser|device)|is this your device|remember it for future logins/i.test(
      state.text,
    );
  if (trustScreen) {
    // The current Universal Prompt renders this as its primary button. The browser is closed
    // immediately after sign-in, so accepting cannot persist a trusted-device cookie beyond
    // this one ephemeral run.
    const primary = controls.find(({ normalized }) => normalized === "yes this is my device");
    if (primary) return { action: "complete_trust", label: primary.label };

    const decline = controls.find(({ normalized }) =>
      /^(?:no )?(?:(?:do not|dont) trust(?: this| the)? browser|other people use this device|skip)$/.test(
        normalized,
      ),
    );
    if (decline) return { action: "decline_trust", label: decline.label };
  }

  const approved = /\b(?:approved|success|verified|authentication complete|verification complete)\b/i.test(
    state.text,
  );
  if (approved) {
    const continueControl = controls.find(({ normalized }) =>
      /^(?:continue|continue to (?:login|sign in)|finish|done)$/.test(normalized),
    );
    if (continueControl) {
      return { action: "continue_after_approval", label: continueControl.label };
    }
  }

  const push = controls.find(({ normalized }) =>
    /^(?:verify with )?duo push(?: to .+)?$|^send (?:me )?a push$/.test(normalized),
  );
  if (push) return { action: "duo_push", label: push.label };

  // Never open the method chooser while a push is already waiting; doing so cancels a valid
  // request and can create MFA fatigue if the loop sends another one.
  if (duoPushIsPending(state)) return null;

  const otherOptions = controls.find(({ normalized }) => normalized === "other options");
  return otherOptions ? { action: "other_options", label: otherOptions.label } : null;
}

export function duoPushIsPending(state: Pick<FrameState, "url" | "text">): boolean {
  if (!/duo|duosecurity/i.test(`${state.url}\n${state.text}`)) return false;
  return /check (?:for )?a duo push|push (?:notification )?(?:has been |was )?sent|approve (?:the )?(?:login|notification|request)|waiting for (?:a )?(?:duo )?push|enter (?:the )?(?:verification )?code.*duo mobile/i.test(
    state.text,
  );
}

/** Extracts the short-lived Verified Duo Push code without matching unrelated page numbers. */
export function extractDuoVerificationCode(
  state: Pick<FrameState, "url" | "text">,
): string | null {
  if (!/duo|duosecurity/i.test(`${state.url}\n${state.text}`)) return null;

  const text = state.text.replace(/[\u00a0\s]+/g, " ").trim();
  const patterns = [
    /(?:verification|security|duo) code\D{0,80}(?<!\d)(\d(?:\s*\d){2})(?!\d)/i,
    /enter\D{0,80}(?<!\d)(\d(?:\s*\d){2})(?!\d)\D{0,80}(?:duo mobile|phone|app)/i,
    /(?<!\d)(\d(?:\s*\d){2})(?!\d)\D{0,80}(?:verification|duo mobile|phone|app)/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match?.[1]) continue;
    const code = match[1].replace(/\s/g, "");
    if (/^\d{3}$/.test(code)) return code;
  }
  return null;
}

function actionPriority(action: DuoPageAction): number {
  if (action === "decline_trust" || action === "complete_trust") return 0;
  if (action === "continue_after_approval") return 1;
  if (action === "duo_push") return 2;
  return 3;
}

function normalizeLabel(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[\u2018\u2019']/g, "")
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .trim()
    .toLowerCase();
}

async function clickControl(frame: Frame, wantedLabel: string): Promise<boolean> {
  const result = await frame
    .evaluate(
      (wanted) => {
        const candidates = Array.from(
          document.querySelectorAll<HTMLElement>(
            "button, input[type='button'], input[type='submit'], [role='button'], a",
          ),
        );
        for (const candidate of candidates) {
          const label = (
            candidate.innerText ||
              (candidate as HTMLInputElement).value ||
              candidate.getAttribute("aria-label") ||
              ""
          )
            .normalize("NFKC")
            .replace(/[\u2018\u2019']/g, "")
            .replace(/[^a-zA-Z0-9]+/g, " ")
            .trim()
            .toLowerCase();
          if (label !== wanted) continue;
          if (
            candidate.offsetParent === null ||
            candidate.getAttribute("aria-disabled") === "true"
          ) {
            continue;
          }

          // Return the evaluation result before Duo replaces this frame. A synchronous click can
          // navigate quickly enough to reject the evaluate call even though the control worked.
          setTimeout(() => candidate.click(), 0);
          return { clicked: true, candidates: [] };
        }
        return {
          clicked: false,
          candidates: candidates.map((candidate) => ({
            tag: candidate.tagName.toLowerCase(),
            label: (
              candidate.innerText ||
                (candidate as HTMLInputElement).value ||
                candidate.getAttribute("aria-label") ||
                ""
            )
              .normalize("NFKC")
              .replace(/[\u2018\u2019']/g, "")
              .replace(/[^a-zA-Z0-9]+/g, " ")
              .trim()
              .toLowerCase(),
            visible: candidate.offsetParent !== null,
            disabled: candidate.getAttribute("aria-disabled"),
          })),
        };
      },
      normalizeLabel(wantedLabel),
    )
    .catch((error) => ({
      clicked: false,
      candidates: [],
      error: error instanceof Error ? error.message : String(error),
    }));

  if (!result.clicked && process.env.UWATERLOO_LOGIN_DEBUG === "1") {
    const diagnostic = JSON.stringify({ wanted: normalizeLabel(wantedLabel), ...result });
    if (diagnostic !== lastClickDiagnostic) {
      lastClickDiagnostic = diagnostic;
      console.info("[waterloo-login] Duo click diagnostic", JSON.parse(diagnostic));
    }
  }
  return result.clicked;
}

function safePageLocation(page: Page): string {
  try {
    const url = new URL(page.url());
    return `${url.hostname}${url.pathname}`;
  } catch {
    return "unknown";
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
