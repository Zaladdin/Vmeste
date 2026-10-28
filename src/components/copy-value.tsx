"use client";

import { useEffect, useState } from "react";
import { Copy, Check } from "lucide-react";
import "./copy-value.css";

export function CopyValue({ label, value }: { label: string; value: string }) {
  const [status, setStatus] = useState<"idle" | "copied" | "failed">("idle");
  useEffect(() => {
    setStatus("idle");
  }, [value]);
  useEffect(() => {
    if (status === "idle") return;
    const timer = setTimeout(() => setStatus("idle"), 4000);
    return () => clearTimeout(timer);
  }, [status]);
  return (
    <div className="identity-code">
      <span>{label}</span>
      <code>{value}</code>
      <button
        type="button"
        className="icon-button"
        aria-label={`Скопировать ${label.toLowerCase()}`}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(value);
            setStatus("copied");
          } catch {
            setStatus("failed");
          }
        }}
      >
        {status === "copied" ? <Check size={16} /> : <Copy size={16} />}
      </button>
      {status !== "idle" ? (
        <small role="status">
          {status === "copied"
            ? "Скопировано"
            : "Выделите код и скопируйте вручную."}
        </small>
      ) : null}
    </div>
  );
}
