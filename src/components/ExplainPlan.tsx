import { Fragment } from "react";
import { AlertTriangle, Cpu, ExternalLink, ListTree } from "lucide-react";
import { useStudio } from "../state/store";
import { EmptyState, Spinner } from "./ui";
import type { PlanNode } from "../utils/api";

function Row({ node, depth, maxCost }: { node: PlanNode; depth: number; maxCost: number }) {
  const pct = maxCost > 0 ? Math.round((node.cost / maxCost) * 100) : 0;
  const heavy = pct > 50 && !node.children?.length;
  return (
    <Fragment>
      <tr className="hover:bg-accentdim/50">
        <td className="py-1 pr-3 whitespace-nowrap font-mono text-[12px]">
          <span style={{ paddingLeft: depth * 18 }} className="inline-flex items-center gap-1.5">
            <span className="text-mute">{depth > 0 ? "└─" : ""}</span>
            <span className={heavy ? "text-warn font-semibold" : "text-ink"}>{node.op}</span>
            {node.object && <span className="text-accenthi font-semibold">{node.object}</span>}
            {heavy && <AlertTriangle size={12} className="text-warn" aria-label="High-cost step" />}
          </span>
        </td>
        <td className="py-1 px-3 text-right tabular-nums text-soft text-[12px]">{node.cost.toLocaleString()}</td>
        <td className="py-1 px-3 text-right tabular-nums text-soft text-[12px]">{node.rows.toLocaleString()}</td>
        <td className="py-1 px-3 text-right tabular-nums text-soft text-[12px]">{node.bytes}</td>
        <td className="py-1 pl-3 w-40">
          <div className="h-2 rounded-full bg-[var(--viz-grid)] overflow-hidden" role="img" aria-label={`${pct}% of total cost`}>
            <div className="h-full rounded-full" style={{ width: `${Math.max(pct, 2)}%`, background: heavy ? "var(--viz-serious)" : "var(--viz-1)" }} />
          </div>
        </td>
        <td className="py-1 pl-3 text-[11px] text-mute italic whitespace-nowrap max-w-[280px] overflow-hidden text-ellipsis" title={node.note ?? ""}>
          {node.note ?? ""}
        </td>
      </tr>
      {node.children?.map((c, i) => (
        <Row key={i} node={c} depth={depth + 1} maxCost={maxCost} />
      ))}
    </Fragment>
  );
}

/** Highest-cost leaf node — the step worth flagging in the advisor line. */
function heaviestLeaf(node: PlanNode): PlanNode {
  if (!node.children?.length) return node;
  return node.children.map(heaviestLeaf).reduce((a, b) => (b.cost > a.cost ? b : a));
}

export default function ExplainPlan() {
  const s = useStudio();
  const res = s.plan;

  if (s.planLoading) {
    return (
      <div className="h-full flex items-center justify-center">
        <Spinner label="Building execution plan…" />
      </div>
    );
  }

  if (!res) {
    return (
      <EmptyState
        icon={<ListTree />}
        title="No execution plan yet"
        hint="Click Explain to run EXPLAIN PLAN on the current statement and see how the database will execute it."
      />
    );
  }

  if (res.error) {
    return (
      <div className="p-4 df-fade">
        <div className="border border-err/40 bg-err/8 rounded-lg p-3.5 max-w-2xl">
          <div className="flex items-center gap-2 text-err font-semibold text-[13px]">
            <AlertTriangle size={15} />
            {res.error.code} — could not build the execution plan
          </div>
          <div className="mt-1.5 text-[12.5px] text-ink font-mono whitespace-pre-wrap">{res.error.message}</div>
          {res.error.helpUrl && (
            <a
              href={res.error.helpUrl}
              target="_blank"
              rel="noreferrer"
              className="mt-1.5 inline-flex items-center gap-1 text-[11.5px] text-accent hover:underline"
            >
              <ExternalLink size={11} /> Oracle documentation for {res.error.code}
            </a>
          )}
        </div>
      </div>
    );
  }

  if (!res.plan) {
    return <EmptyState icon={<ListTree />} title="No plan rows" hint={res.note ?? "The database returned no execution plan for this statement."} />;
  }

  const maxCost = res.plan.cost || 1;
  const worst = heaviestLeaf(res.plan);
  const worstPct = maxCost > 0 ? Math.round((worst.cost / maxCost) * 100) : 0;
  const engineLabel = "Oracle cost-based optimizer";

  return (
    <div className="h-full overflow-auto p-3 df-fade">
      <div className="flex items-center gap-2 mb-2 text-[12px] text-soft">
        <Cpu size={14} className="text-accent" />
        <span className="font-semibold text-ink">Execution plan</span>
        <span>
          — {engineLabel}, estimated. Total cost {res.totalCost.toLocaleString()}. Bars show share of total cost.
        </span>
      </div>
      <div className="border border-bdr rounded-lg overflow-auto bg-panel">
        <table className="w-full text-left border-collapse min-w-[720px]">
          <thead>
            <tr className="text-[10.5px] uppercase tracking-wider text-mute border-b border-bdr">
              <th className="py-1.5 pl-3 font-semibold">Operation</th>
              <th className="py-1.5 px-3 text-right font-semibold">Cost</th>
              <th className="py-1.5 px-3 text-right font-semibold">Rows</th>
              <th className="py-1.5 px-3 text-right font-semibold">Bytes</th>
              <th className="py-1.5 pl-3 font-semibold">% Cost</th>
              <th className="py-1.5 pl-3 font-semibold">Predicate / note</th>
            </tr>
          </thead>
          <tbody className="[&>tr]:border-b [&>tr]:border-bdrsoft">
            <Row node={res.plan} depth={0} maxCost={maxCost} />
          </tbody>
        </table>
      </div>
      {worstPct > 40 && worst.object && (
        <div className="mt-2 flex items-start gap-2 text-[12px] bg-warn/8 border border-warn/25 rounded-lg px-3 py-2 text-soft">
          <AlertTriangle size={14} className="text-warn shrink-0 mt-0.5" />
          <span>
            <b className="text-ink">Advisor:</b> <span className="font-mono text-accenthi">{worst.op}</span> on{" "}
            <span className="font-mono text-accenthi">{worst.object}</span> is the heaviest step (~{worstPct}% of total cost
            {worst.rows ? `, ~${worst.rows.toLocaleString()} rows` : ""}). Review indexes, predicates, and join order before tuning.
          </span>
        </div>
      )}
    </div>
  );
}
