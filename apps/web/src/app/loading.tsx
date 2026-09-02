export default function Loading() {
  return (
    <main className="page" aria-busy="true">
      <div className="eyebrow">LOADING CREATOROS</div>
      <h1>Preparing the operating view…</h1>
      <div className="grid metrics-grid">
        {[1, 2, 3, 4].map((item) => (
          <div className="card metric-card" style={{ opacity: 0.55 }} key={item} />
        ))}
      </div>
    </main>
  );
}
