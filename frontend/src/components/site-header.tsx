import Link from "next/link";
import { Download } from "lucide-react";
import { PuffLogo } from "./puff-logo";
import { INSTALLER_URL, REPO_URL } from "@/lib/site";

const nav = [
  { href: "#platform", label: "Platform" },
  { href: "#playground", label: "Playground" },
  { href: "#integrations", label: "Integrations" },
  { href: REPO_URL, label: "GitHub" },
];

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-30 bg-[#08090c]/85 backdrop-blur-md px-0 sm:px-52">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-4 border-b-[1.5px] border-dashed border-slate-500 px-4 sm:px-0">
        <Link href="/" aria-label="Puff — home" className="flex items-center">
          <PuffLogo className="h-8 w-auto" />
        </Link>

        <nav className="hidden items-center gap-8 text-sm text-slate-400 md:flex">
          {nav.map((item) => {
            const isExternal = item.href.startsWith("http");
            return (
              <a
                key={item.label}
                href={item.href}
                target={isExternal ? "_blank" : undefined}
                rel={isExternal ? "noreferrer" : undefined}
                className="transition-colors duration-150 ease-out hover:text-white"
              >
                {item.label}
              </a>
            );
          })}
        </nav>

        {/* The one download button in the bar: it saves the newest installer. */}
        <a
          href={INSTALLER_URL}
          rel="noreferrer"
          className="inline-flex h-10 items-center justify-center gap-2 whitespace-nowrap rounded-none bg-white px-5 text-sm font-semibold text-slate-950 transition-[transform,opacity] duration-150 ease-out hover:opacity-90 active:scale-[0.97]"
        >
          <Download className="h-4 w-4" strokeWidth={2} aria-hidden="true" />
          Download
        </a>
      </div>
    </header>
  );
}
