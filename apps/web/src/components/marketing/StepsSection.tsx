"use client";

import { useEffect, useRef } from "react";

const steps = [
  {
    num: "01",
    title: "Upload video + cert",
    body: "Grader uploads a 360° turntable video and GIA/IGI certificate. Cert fields are auto-parsed; Carat comes from the cert, never estimated by CV.",
  },
  {
    num: "02",
    title: "AI pre-screens; grader confirms",
    body: "CV model pre-screens Color, Clarity, and Cut with per-dimension confidence scores and cert-disagreement flags. Grader reviews and confirms or overrides each grade before the stone can proceed.",
  },
  {
    num: "03",
    title: "Price forecast generated",
    body: "XGBoost model produces a fair price estimate and confidence band. Sales staff reviews, applies markup, and publishes the stone to the private catalog with buyer-specific pricing.",
  },
  {
    num: "04",
    title: "Buyer browses, inquires, and closes",
    body: "Buyers browse the private catalog, open the 3D viewer, and submit inquiries. Sales manages quotes and soft reservations in the lightweight CRM. Closing a deal appends a 'sold' event to the Diamond Passport.",
  },
];

export default function StepsSection() {
  const refs = useRef<(HTMLDivElement | null)[]>([]);

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            (entry.target as HTMLElement).style.opacity = "1";
            (entry.target as HTMLElement).style.transform = "translateY(0)";
            observer.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.15 }
    );

    refs.current.forEach((el) => {
      if (el) observer.observe(el);
    });

    return () => observer.disconnect();
  }, []);

  return (
    <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
      {steps.map((s, i) => (
        <div
          key={s.num}
          ref={(el) => { refs.current[i] = el; }}
          style={{
            opacity: 0,
            transform: "translateY(28px)",
            transition: `opacity 0.5s ease ${i * 120}ms, transform 0.5s ease ${i * 120}ms`,
          }}
        >
          <div className="text-4xl font-bold text-lc-blue/30 mb-3">{s.num}</div>
          <h3 className="font-semibold text-lc-text mb-2">{s.title}</h3>
          <p className="text-sm text-lc-muted leading-relaxed">{s.body}</p>
        </div>
      ))}
    </div>
  );
}
