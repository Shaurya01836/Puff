import Link from "next/link";

const nav = [
  { href: '#platform', label: 'Platform' },
  { href: '#architecture', label: 'Architecture' },
  { href: '#playground', label: 'Playground' },
  { href: '#download', label: 'Download' },
  { href: 'https://github.com/Shaurya01836/Puff', label: 'GitHub' },
];

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-30 bg-[#08090c]/85 backdrop-blur-md px-0 sm:px-52">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-4 border-b-[1.5px] border-dashed border-slate-500 px-4 sm:px-0">
        <Link
          href="/"
          className="font-display text-lg font-bold tracking-tight text-white"
        >
          Puff
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

        <a
          href="#download"
          className="inline-flex h-10 items-center justify-center whitespace-nowrap rounded-none bg-white px-5 text-sm font-semibold text-slate-950 transition-[transform,opacity] duration-150 ease-out hover:opacity-90 active:scale-[0.97]"
        >
          Launch
        </a>
      </div>
    </header>
  );
}
