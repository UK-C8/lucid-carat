"use client";
import { useState } from "react";

interface Props {
  source?: string;
  compact?: boolean;
}

export default function DemoRequestForm({ source = "lucidcarat_landing", compact = false }: Props) {
  const [state, setState] = useState<"idle" | "submitting" | "done" | "error">("idle");
  const [form, setForm] = useState({ name: "", email: "", company: "", message: "" });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.email) return;
    setState("submitting");
    try {
      const res = await fetch("/api/marketing/leads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...form, source }),
      });
      setState(res.ok ? "done" : "error");
    } catch {
      setState("error");
    }
  }

  if (state === "done") {
    return (
      <div className="bg-lc-surface border border-lc-emerald/40 rounded-xl p-8 text-center">
        <div className="text-3xl mb-3">✓</div>
        <p className="text-lc-text font-semibold mb-1">Request received</p>
        <p className="text-sm text-lc-muted">
          The Centr8 team will be in touch within one business day.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      {!compact && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="block text-xs text-lc-muted mb-1.5">Your name</label>
            <input
              type="text"
              value={form.name}
              onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
              placeholder="Rajesh Mehta"
              className="w-full bg-lc-bg border border-lc-border text-lc-text text-sm rounded-lg px-4 py-2.5 placeholder-lc-muted/50 focus:outline-none focus:border-lc-blue transition-colors"
            />
          </div>
          <div>
            <label className="block text-xs text-lc-muted mb-1.5">Company / house</label>
            <input
              type="text"
              value={form.company}
              onChange={e => setForm(f => ({ ...f, company: e.target.value }))}
              placeholder="Shree Diamonds Pvt. Ltd."
              className="w-full bg-lc-bg border border-lc-border text-lc-text text-sm rounded-lg px-4 py-2.5 placeholder-lc-muted/50 focus:outline-none focus:border-lc-blue transition-colors"
            />
          </div>
        </div>
      )}

      <div>
        <label className="block text-xs text-lc-muted mb-1.5">Work email <span className="text-lc-blue">*</span></label>
        <input
          type="email"
          required
          value={form.email}
          onChange={e => setForm(f => ({ ...f, email: e.target.value }))}
          placeholder="you@yourcompany.com"
          className="w-full bg-lc-bg border border-lc-border text-lc-text text-sm rounded-lg px-4 py-2.5 placeholder-lc-muted/50 focus:outline-none focus:border-lc-blue transition-colors"
        />
      </div>

      {!compact && (
        <div>
          <label className="block text-xs text-lc-muted mb-1.5">Anything specific you want to see?</label>
          <textarea
            rows={3}
            value={form.message}
            onChange={e => setForm(f => ({ ...f, message: e.target.value }))}
            placeholder="e.g. grading accuracy, provenance export, API access…"
            className="w-full bg-lc-bg border border-lc-border text-lc-text text-sm rounded-lg px-4 py-2.5 placeholder-lc-muted/50 focus:outline-none focus:border-lc-blue transition-colors resize-none"
          />
        </div>
      )}

      {state === "error" && (
        <p className="text-xs text-red-400">Something went wrong — please try again or email us directly.</p>
      )}

      <button
        type="submit"
        disabled={state === "submitting"}
        className="w-full bg-lc-blue hover:bg-lc-blue-light disabled:opacity-60 text-white font-semibold text-sm rounded-lg px-6 py-3 transition-colors"
      >
        {state === "submitting" ? "Sending…" : "Request a demo"}
      </button>

      <p className="text-xs text-lc-muted text-center">
        No commitment. The Centr8 team will follow up within one business day.
      </p>
    </form>
  );
}
