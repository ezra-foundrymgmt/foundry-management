export function PageHeader({
  eyebrow,
  title,
  subtitle,
  actions,
}: {
  eyebrow?: string;
  title: string;
  subtitle: string;
  actions?: React.ReactNode;
}) {
  return (
    <header className="page-header">
      <div>
        {eyebrow ? <div className="eyebrow">{eyebrow}</div> : null}
        <h1>{title}</h1>
        <p className="subtitle">{subtitle}</p>
      </div>
      {actions ? <div className="actions">{actions}</div> : null}
    </header>
  );
}

export function DemoStrip() {
  return (
    <div className="demo-strip">
      <span>
        <strong>DEMO MODE</strong> · Fictional operating data · Mock integrations
      </span>
      <span>Last refreshed 8:30 AM CT</span>
    </div>
  );
}
