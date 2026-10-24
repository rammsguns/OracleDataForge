import { useEffect, useRef, useState } from "react";
import DiffView from "./DiffView";
import { Btn } from "./ui";
import { answerEvent, emptyAnswer, sseParser } from "../utils/assist";

type Body = { action: string; connectionId: string; schema: string; selection: string; editorId: string; editorRevision: string; question: string };
async function jsonPost(url: string, body: unknown) {
  const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
  return data;
}

export default function AssistPanel({ text, selection, connectionId, schema, editorId, onApply }: {
  text: string; selection: string; connectionId: string; schema: string; editorId: string; onApply: (text: string) => void;
}) {
  const [caps, setCaps] = useState<{actions: string[]; detail: string; enabled: boolean; reachable: boolean; compatible: boolean; providerReady?: boolean} | null>(null);
  const [action, setAction] = useState("explain");
  const [question, setQuestion] = useState("");
  const [review, setReview] = useState<{ body: Body; preview: unknown } | null>(null);
  const [answer, setAnswer] = useState(emptyAnswer);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const source = useRef({text, revision: crypto.randomUUID()});
  if (source.current.text !== text) source.current = { text, revision: crypto.randomUUID() };
  const current = useRef({text, revision: source.current.revision});
  current.current = {text, revision: source.current.revision};
  const refresh = () => { void fetch("/api/ai/capabilities").then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); }).then(setCaps).catch(() => setNotice("Harness unavailable. Refresh integration status to retry.")); };
  useEffect(() => { mounted.current = true; refresh(); return () => { mounted.current = false; controller.current?.abort(); }; }, []);
  const body = (): Body => ({ action, connectionId, schema, selection: selection || text, editorId, editorRevision: source.current.revision, question });
  const reviewContext = async () => {
    setBusy(true); setNotice(""); setReview(null);
    try { const request = body(); setReview({ body: request, preview: await jsonPost("/api/ai/context-preview", request) }); }
    catch (cause) { setNotice((cause as Error).message); }
    finally { setBusy(false); }
  };
  const send = async () => {
    if (!review) return;
    const request = review.body;
    if (JSON.stringify(request) !== JSON.stringify(body())) { setReview(null); setNotice("Context changed. Review outgoing context again."); return; }
    const abort = new AbortController(); controller.current = abort;
    setAnswer({...emptyAnswer(), status: "streaming"}); setReview(null); setBusy(true); setNotice("");
    try {
      const response = await fetch("/api/ai/chat", {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(request), signal: abort.signal});
      if (!response.ok || !response.body) throw new Error(`Assist HTTP ${response.status}`);
      const reader = response.body.getReader(); const decoder = new TextDecoder();
      const feed = sseParser(event => { if (!abort.signal.aborted) setAnswer(previous => answerEvent(previous, event)); });
      while (true) { const {done, value} = await reader.read(); if (done) break; feed(decoder.decode(value, {stream: true})); }
      feed(decoder.decode());
      if (!abort.signal.aborted) setAnswer(previous => previous.status === "streaming" ? {...previous, status: "Stream ended before completion"} : previous);
    } catch (cause) { if (!abort.signal.aborted) setNotice(`Harness unavailable: ${(cause as Error).message}`); }
    finally { if (controller.current === abort) { controller.current = null; setBusy(false); } }
  };
  const cancel = () => { controller.current?.abort(); setAnswer(previous => ({...previous, status: "cancelled", proposal: null})); setBusy(false); };
  const apply = async () => {
    if (!answer.proposal) return;
    setBusy(true);
    const snapshot = {...current.current};
    try {
      const result = await jsonPost(`/api/ai/proposals/${encodeURIComponent(String(answer.proposal.proposalId))}/apply-check`, {editorId, connectionId, schema, revision: snapshot.revision, currentText: snapshot.text});
      if (!mounted.current) return;
      if (current.current.revision !== snapshot.revision) { setNotice("Editor changed during apply check. Review again."); return; }
      if (result.canApply && typeof result.proposedText === "string") { onApply(result.proposedText); setNotice("Applied to editor. Nothing executed."); }
      else setNotice(`Apply refused: ${(result.reasons ?? []).join(", ")}`);
    } catch (cause) { setNotice(`Apply unavailable: ${(cause as Error).message}`); }
    finally { setBusy(false); }
  };
  const available = caps?.enabled && caps.reachable && caps.compatible && caps.providerReady !== false;
  return <section aria-label="Assist panel" className="border-b border-bdrsoft bg-panel2 p-3 text-[12px] max-h-[55vh] overflow-auto shrink-0">
    <div className="flex gap-2 items-center"><strong>Assist</strong><Btn onClick={refresh} disabled={busy}>Refresh integration status</Btn></div>
    <p role="status">{caps ? caps.detail || (available ? "Harness ready" : "Assistance unavailable") : "Checking integration…"}</p>
    <div className="flex gap-2 my-2"><select aria-label="Assist action" value={action} onChange={e => {setAction(e.target.value); setReview(null);}} disabled={busy || !available}>{caps?.actions.map(a => <option key={a} value={a}>{a}</option>)}</select>
    <input aria-label="Assist question" className="bg-panel border border-bdr flex-1 px-2" value={question} disabled={busy} onChange={e => {setQuestion(e.target.value); setReview(null);}} placeholder="Ask about the selected SQL" />
    <Btn disabled={busy || !available || !caps?.actions.includes(action)} onClick={() => void reviewContext()}>Review outgoing context</Btn>
    {busy && controller.current && <Btn onClick={cancel}>Cancel</Btn>}</div>
    {review && <div aria-label="Outgoing context"><p>Review selection, target and schema before sending. Question: {review.body.question}</p><pre className="whitespace-pre-wrap">{JSON.stringify(review.preview, null, 2)}</pre><Btn onClick={() => void send()}>Send {review.body.action}</Btn></div>}
    <p data-testid="assist-status">{answer.status}</p><p>{answer.provider}{answer.model && ` · ${answer.model}`}</p>
    <pre data-testid="assist-answer" data-updates={answer.updates} data-request-id={answer.requestId} className="whitespace-pre-wrap">{answer.text}</pre>
    {answer.proposal && <div aria-label="Proposal diff" className="flex flex-col max-h-56"><DiffView oldSrc={text} newSrc={String(answer.proposal.proposedText ?? "")} /><Btn disabled={busy} onClick={() => void apply()}>Apply proposal</Btn></div>}
    <p role="alert">{notice}</p>
  </section>;
}
