"use client";
import { useFormStatus } from "react-dom";
import { Loader2, Send } from "lucide-react";

export default function SendButton({ n, smtp }: { n: number; smtp: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button disabled={!n || pending} onClick={(e) => { if (!confirm(`${smtp ? "Send" : "Write"} ${n} emails${smtp ? " to real recipients" : " to the local outbox"}?`)) e.preventDefault(); }} className="btn btn-accent disabled:opacity-40">
      {pending ? <><Loader2 className="size-4 animate-spin" />Sending…</> : <><Send className="size-4" />Send {n} emails</>}
    </button>
  );
}
