"use client";

import { useEffect, useRef } from "react";

interface FadeInProps {
  children: React.ReactNode;
  className?: string;
  delay?: number;
  direction?: "up" | "left" | "right" | "none";
}

export default function FadeIn({
  children,
  className = "",
  delay = 0,
  direction = "up",
}: FadeInProps) {
  const ref = useRef<HTMLDivElement>(null);

  const initialTransform =
    direction === "up"
      ? "translateY(32px)"
      : direction === "left"
      ? "translateX(-32px)"
      : direction === "right"
      ? "translateX(32px)"
      : "none";

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    // If already in viewport on mount (above-the-fold), animate immediately
    const rect = el.getBoundingClientRect();
    if (rect.top < window.innerHeight) {
      const t = setTimeout(() => {
        el.style.opacity = "1";
        el.style.transform = "translate(0)";
      }, delay);
      return () => clearTimeout(t);
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          el.style.opacity = "1";
          el.style.transform = "translate(0)";
          observer.disconnect();
        }
      },
      { threshold: 0.1 }
    );

    observer.observe(el);
    return () => observer.disconnect();
  }, [delay]);

  return (
    <div
      ref={ref}
      className={className}
      style={{
        opacity: 0,
        transform: initialTransform,
        transition: `opacity 0.6s ease ${delay}ms, transform 0.6s ease ${delay}ms`,
      }}
    >
      {children}
    </div>
  );
}
