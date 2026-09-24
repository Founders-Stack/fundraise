"use client";

import { Moon, Sun } from "lucide-react";

export function ThemeToggle() {
  function toggle() {
    const dark = !document.documentElement.classList.contains("dark");
    document.documentElement.classList.toggle("dark", dark);
    try {
      localStorage.setItem("fs-theme", dark ? "dark" : "light");
    } catch {
      /* storage unavailable */
    }
  }
  return (
    <button
      type="button"
      onClick={toggle}
      aria-label="Toggle light / dark theme"
      className="inline-flex size-9 items-center justify-center rounded-[3px] border border-input bg-card text-muted-foreground transition-colors hover:text-foreground"
    >
      <Sun className="hidden size-4 dark:block" />
      <Moon className="size-4 dark:hidden" />
    </button>
  );
}
