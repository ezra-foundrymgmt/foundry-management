"use client";
import { useEffect, useState } from "react";
import { creators, tasks as seededTasks, type Task } from "@creatoros/domain";
import { Filter, Plus } from "lucide-react";
import { DemoStrip, PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";

export default function TasksPage() {
  type DisplayTask = Task & { creatorName?: string; updatedAt?: string };
  const demo = process.env["NEXT_PUBLIC_CREATOROS_DEMO_MODE"] !== "false";
  const [tasks, setTasks] = useState<DisplayTask[]>(demo ? seededTasks : []);
  const [message, setMessage] = useState("");
  useEffect(() => {
    if (!demo)
      void fetch("/api/tasks")
        .then((response) => response.json())
        .then((body: { data?: DisplayTask[] }) => setTasks(body.data ?? []));
  }, [demo]);
  const advance = async (task: DisplayTask) => {
    const status = task.status === "OPEN" ? "IN_PROGRESS" : "DONE";
    if (demo || !task.updatedAt) {
      setTasks((current) =>
        current.map((item) => (item.id === task.id ? { ...item, status } : item)),
      );
      return;
    }
    const response = await fetch(`/api/tasks/${task.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status, updatedAt: task.updatedAt }),
    });
    const result = (await response.json()) as {
      status?: Task["status"];
      updatedAt?: string;
      error?: string;
    };
    if (!response.ok || !result.status || !result.updatedAt) {
      setMessage(result.error ?? "Task update failed");
      return;
    }
    const newStatus = result.status;
    const newUpdatedAt = result.updatedAt;
    setTasks((current) =>
      current.map((item) =>
        item.id === task.id ? { ...item, status: newStatus, updatedAt: newUpdatedAt } : item,
      ),
    );
  };
  return (
    <main className="page">
      <DemoStrip />
      <PageHeader
        eyebrow="Execution"
        title="Tasks"
        subtitle="Internal work linked to creators, reports, prospects, and workflow runs."
        actions={
          <button
            className="button primary"
            disabled
            title="Create direct tasks after the live database is connected"
          >
            <Plus size={14} /> Create task
          </button>
        }
      />
      {message ? (
        <div className="demo-strip" role="status">
          {message}
        </div>
      ) : null}
      <section className="card">
        <div className="table-toolbar">
          <button className="button" disabled title="Department filters require the live database">
            <Filter size={13} /> All departments
          </button>
          <button className="button" disabled title="Saved views require the live database">
            Open work
          </button>
          <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--ink-soft)" }}>
            {tasks.filter((item) => item.status !== "DONE").length} open
          </span>
        </div>
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Task</th>
                <th>Creator</th>
                <th>Department</th>
                <th>Priority</th>
                <th>Owner</th>
                <th>Due</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {tasks.map((task) => {
                const creator = creators.find((item) => item.id === task.creatorId);
                return (
                  <tr key={task.id}>
                    <td>
                      <strong>{task.title}</strong>
                      <br />
                      <span style={{ fontSize: 10, color: "var(--ink-soft)" }}>
                        {task.sourceType} · {task.sourceId ?? "Direct"}
                      </span>
                    </td>
                    <td>{task.creatorName ?? creator?.stageName ?? "Foundry"}</td>
                    <td>{task.department}</td>
                    <td>
                      <StatusBadge value={task.priority} />
                    </td>
                    <td>{task.owner}</td>
                    <td>{task.dueAt}</td>
                    <td>
                      <StatusBadge value={task.status} />
                    </td>
                    <td>
                      <button
                        className="button"
                        disabled={task.status === "DONE"}
                        onClick={() => void advance(task)}
                      >
                        {task.status === "OPEN"
                          ? "Start"
                          : task.status === "DONE"
                            ? "Completed"
                            : "Complete"}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}
