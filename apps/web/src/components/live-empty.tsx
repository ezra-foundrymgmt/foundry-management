/**
 * Shown on a live page that has no rows yet.
 *
 * The alternative — falling back to seed fixtures — would put Madison Carter and
 * invented revenue figures in front of an operator as though they were Foundry's
 * real data. An empty state is honest; demo data on a live deployment is not.
 */
export function LiveEmpty({ title, hint }: { title: string; hint: string }) {
  return (
    <section className="card card-pad">
      <div className="empty-state" style={{ padding: 32 }}>
        <strong>{title}</strong>
        {hint}
      </div>
    </section>
  );
}
