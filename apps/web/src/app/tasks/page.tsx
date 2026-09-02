"use client";
import { useState } from "react";
import { creators, tasks as seededTasks, type Task } from "@creatoros/domain";
import { Filter, Plus } from "lucide-react";
import { DemoStrip, PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";

export default function TasksPage() {
  const [tasks, setTasks] = useState<Task[]>(seededTasks);
  const advance = (task: Task) =>
    setTasks((current) =>
      current.map((item) =>
        item.id === task.id
          ? { ...item, status: item.status === "OPEN" ? "IN_PROGRESS" : "DONE" }
          : item,
      ),
    );
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
                    <td>{creator?.stageName ?? "Foundry"}</td>
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
                        onClick={() => advance(task)}
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
