export interface AssistEvent { event: string; data: Record<string, unknown> }

/** Incremental SSE decoder: retain incomplete frames, including split CRLF. */
export function sseParser(emit: (event: AssistEvent) => void) {
  let pending = "";
  return (chunk: string) => {
    pending += chunk;
    let boundary: RegExpExecArray | null;
    while ((boundary = /\r?\n\r?\n/.exec(pending))) {
      const block = pending.slice(0, boundary.index);
      pending = pending.slice(boundary.index + boundary[0].length);
      let event = "message";
      const data: string[] = [];
      for (const line of block.split(/\r?\n/)) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
      }
      if (data.length) emit({ event, data: JSON.parse(data.join("\n")) as Record<string, unknown> });
    }
  };
}

export interface AnswerState {
  status: string; text: string; provider: string; model: string; requestId: string;
  proposal: Record<string, unknown> | null; updates: number;
}
export const emptyAnswer = (): AnswerState => ({ status: "ready", text: "", provider: "", model: "", requestId: "", proposal: null, updates: 0 });
export function answerEvent(state: AnswerState, { event, data }: AssistEvent): AnswerState {
  if (state.status === "cancelled") return state;
  if (event === "start") return { ...state, requestId: String(data.requestId ?? ""), provider: String(data.provider ?? ""), model: String(data.model ?? "") };
  if (event === "delta") return { ...state, text: state.text + String(data.text ?? ""), updates: state.updates + 1 };
  if (event === "proposal") return { ...state, proposal: data };
  if (event === "error") return { ...state, status: `${data.code}: ${data.message}` };
  if (event === "done" && state.status === "streaming") return { ...state, status: String(data.outcome ?? "done") };
  return state;
}
