import { useState } from 'react';
import { Globe, Lightbulb, ShieldCheck, Tags, X } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

const NOTE = 'Built with SSRF protections. Research time and depth depend on source availability and model limits.';

const BENEFITS: { icon: LucideIcon; title: string; detail: string }[] = [
  { icon: Globe, title: 'Live Web Research', detail: "Fetches the company's own public pages" },
  { icon: Tags, title: 'Product & Pricing Analysis', detail: 'Positioning, plans and published prices' },
  { icon: ShieldCheck, title: 'Evidence Validation', detail: 'Claims checked against citations and calculations' },
  { icon: Lightbulb, title: 'Actionable Insights', detail: 'Prioritised recommendations with KPIs to track' },
];

/**
 * Introduces what NexusAgent does for the user and how. Dismissal lives in component state only: it lasts while the
 * simulator stays mounted (tab switches included) and resets on reload.
 */
export default function HeroBanner({ onDismiss }: { onDismiss?: () => void }) {
  const [open, setOpen] = useState(true);
  if (!open) return null;

  return (
    <section
      aria-labelledby="hero-headline"
      className="relative overflow-hidden rounded-xl border border-slate-800 bg-gradient-to-br from-slate-900 via-slate-900/80 to-indigo-950/40 px-4 py-4 sm:px-6"
    >
      <button
        type="button"
        onClick={() => {
          setOpen(false);
          onDismiss?.();
        }}
        aria-label="Dismiss introduction"
        title="Dismiss"
        className="absolute right-3 top-3 flex h-8 w-8 items-center justify-center rounded-md text-slate-400 transition-colors hover:bg-slate-800 hover:text-slate-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-400"
      >
        <X className="h-4 w-4" aria-hidden="true" />
      </button>

      <div className="grid gap-3 lg:grid-cols-12 lg:items-center lg:gap-6">
        <div className="min-w-0 pr-8 lg:col-span-7 lg:pr-0">
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-indigo-300">Autonomous Multi-Agent Deep Research</p>
          <h2 id="hero-headline" className="mt-1.5 text-lg font-semibold leading-snug text-white sm:text-xl lg:text-2xl">
            Understand any business. Uncover opportunities. Make better decisions.
          </h2>
          <p className="mt-1.5 text-[13px] leading-snug text-slate-300 sm:text-sm sm:leading-relaxed">
            Turn any company name or public URL into an evidence-backed intelligence report. NexusAgent researches live web pages, analyzes product positioning, pricing
            and customer adoption friction, tests three deductive hypotheses, and validates findings against source citations and deterministic calculations.
          </p>
          <p className="mt-2 hidden text-[11px] leading-snug text-slate-500 lg:block">{NOTE}</p>
        </div>

        {/* lg:pr-8 keeps the ✕ button clear of the first benefit card. */}
        <ul className="grid min-w-0 grid-cols-2 gap-1.5 lg:col-span-5 lg:gap-2 lg:pr-8">
          {BENEFITS.map(({ icon: Icon, title, detail }) => (
            <li key={title} className="flex items-start gap-2 rounded-lg border border-slate-800 bg-slate-950/50 px-2.5 py-2 lg:block lg:px-3 lg:py-2.5">
              <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-indigo-300 lg:mt-0 lg:h-4 lg:w-4" aria-hidden="true" />
              <div className="min-w-0">
                <p className="text-[11.5px] font-semibold leading-tight text-slate-100 lg:mt-1.5 lg:text-sm">{title}</p>
                <p className="mt-0.5 hidden text-[11px] leading-snug text-slate-400 lg:block">{detail}</p>
              </div>
            </li>
          ))}
        </ul>
      </div>

      {/* On small screens the note sits below the benefits; on desktop it lives in the text column. */}
      <p className="mt-3 text-[11px] leading-snug text-slate-500 lg:hidden">{NOTE}</p>
    </section>
  );
}
