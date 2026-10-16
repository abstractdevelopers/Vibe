/**
 * AI assistance boundary (§4.10, Phase 5).
 *
 * The spec is explicit: an AI may *propose* — draft a plan, summarize a Circle,
 * suggest events, propose a budget, prepare a reminder — but it must never take
 * a consequential action (send, book, buy, move money) on its own. So the
 * interface below only ever produces a *suggestion*; turning one into a real
 * object goes through the ordinary, user-driven endpoints.
 *
 * Two implementations sit behind the seam:
 *
 *   - StubAssist: deterministic, local, no network. It composes a proposal from
 *     data already in the request. This is what runs by default and in tests.
 *   - RemoteAssist: the shape a real provider integration would take. It is not
 *     selected unless credentials are configured, mirroring the payments seam.
 */

export interface AssistContext {
  kind: AssistKind;
  /** Free text the person supplied, if any. */
  prompt?: string;
  /** Small, already-authorized facts the caller gathered (counts, names). */
  facts?: Record<string, unknown>;
}

export type AssistKind =
  | "draft_plan"
  | "summarize_circle"
  | "suggest_events"
  | "propose_budget"
  | "reminder";

export interface Suggestion {
  /** Short, human-readable title for the proposal. */
  title: string;
  /** The proposed content. Never an instruction to act; always a draft. */
  body: string;
  /** Structured fields the client can pre-fill a form with, if the user accepts. */
  fields?: Record<string, unknown>;
}

export interface AssistProvider {
  readonly name: string;
  propose(ctx: AssistContext): Promise<Suggestion>;
}

/**
 * Deterministic local assistant. No network, no model, no data leaves the
 * process. Good enough to exercise the whole flow honestly, and it never
 * invents facts it was not given.
 */
export class StubAssist implements AssistProvider {
  readonly name = "stub";

  async propose(ctx: AssistContext): Promise<Suggestion> {
    const prompt = (ctx.prompt ?? "").trim();
    const facts = ctx.facts ?? {};
    switch (ctx.kind) {
      case "draft_plan": {
        const title = prompt || "Get together";
        return {
          title: `Draft plan: ${title.slice(0, 80)}`,
          body:
            `Here is a draft you can edit before sending. Nothing is shared until you confirm it.\n\n` +
            `• What: ${title}\n` +
            `• When: pick a time that suits the group\n` +
            `• Where: add a place or an online link\n` +
            `• Bring: anything the group should know`,
          fields: { title, description: "", timezone: "UTC" },
        };
      }
      case "summarize_circle": {
        const members = Number(facts.memberCount ?? 0);
        const plans = Number(facts.openPlans ?? 0);
        const outstanding = Number(facts.outstandingMinor ?? 0);
        return {
          title: "Circle summary",
          body:
            `This Circle has ${members} member${members === 1 ? "" : "s"} and ` +
            `${plans} open plan${plans === 1 ? "" : "s"}. ` +
            (outstanding > 0
              ? `There is outstanding shared money to settle.`
              : `Shared money is currently settled.`),
          fields: { memberCount: members, openPlans: plans, outstandingMinor: outstanding },
        };
      }
      case "suggest_events": {
        const city = typeof facts.city === "string" ? facts.city : null;
        return {
          title: "Suggested activities",
          body: city
            ? `Ideas for ${city}: a coffee meet-up, a walk, and a shared meal. ` +
              `These are prompts to start a plan — they are not bookings.`
            : `Ideas to start a plan: a coffee meet-up, a walk, and a shared meal. ` +
              `These are prompts — they are not bookings.`,
          fields: { ideas: ["coffee", "walk", "shared meal"] },
        };
      }
      case "propose_budget": {
        const total = Number(facts.totalMinor ?? 0);
        const people = Math.max(1, Number(facts.people ?? 1));
        // Integer minor units only — never floating-point money.
        const perHead = Math.ceil(total / people);
        return {
          title: "Proposed budget",
          body:
            `A rough budget of ${perHead} minor units per person for ${people} ` +
            `people. You can change the split before anything is saved.`,
          fields: { totalMinor: total, people, perHeadMinor: perHead },
        };
      }
      case "reminder": {
        const what = prompt || "your plan";
        return {
          title: "Reminder draft",
          body: `A gentle reminder about ${what}. Nothing is sent until you approve it.`,
          fields: { what },
        };
      }
    }
  }
}

/**
 * The shape a real provider integration takes. Not enabled by default; a real
 * model would be wired here behind provider/legal review, exactly as the spec
 * requires for consequential AI behaviour.
 */
export class RemoteAssist implements AssistProvider {
  readonly name = "remote";
  constructor(private readonly baseUrl: string, private readonly apiKey: string) {}

  async propose(ctx: AssistContext): Promise<Suggestion> {
    const res = await fetch(`${this.baseUrl}/v1/assist`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify(ctx),
    });
    if (!res.ok) throw new Error(`assist provider responded ${res.status}`);
    return (await res.json()) as Suggestion;
  }
}

export function createAssistProvider(provider: "stub" | "remote", baseUrl?: string, apiKey?: string): AssistProvider {
  if (provider === "remote" && baseUrl && apiKey) return new RemoteAssist(baseUrl, apiKey);
  return new StubAssist();
}
