"use client";

import { useEffect, useRef, useState } from "react";
import { LogOut } from "lucide-react";

export interface AccountIdentity {
  email: string;
  role: string;
  initials: string;
  organizationId: string;
  mock: boolean;
}

export function AccountMenu({ identity }: { identity: AccountIdentity | null }) {
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  if (!identity) {
    return (
      <a className="button" href="/login">
        Sign in
      </a>
    );
  }

  return (
    <div className="account-menu" ref={container}>
      <button
        type="button"
        className="avatar"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Account menu for ${identity.email}`}
        onClick={() => setOpen((value) => !value)}
      >
        {identity.initials}
      </button>
      {open ? (
        <div className="account-popover" role="menu">
          <p className="account-email">{identity.email}</p>
          <p className="account-meta">
            {identity.role.replace(/_/g, " ")}
            {identity.mock ? " · local mock session" : ""}
          </p>
          <form action="/auth/sign-out" method="post">
            <button type="submit" className="button account-signout" role="menuitem">
              <LogOut size={13} /> Sign out
            </button>
          </form>
        </div>
      ) : null}
    </div>
  );
}
