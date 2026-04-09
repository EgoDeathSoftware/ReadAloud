import type { ReactNode } from "react";

interface LayoutProps {
  children: ReactNode;
}

export function Layout({ children }: LayoutProps) {
  return (
    <div className="layout">
      <header className="header">
        <h1>ReadAloud</h1>
      </header>
      <main className="main">{children}</main>
    </div>
  );
}
