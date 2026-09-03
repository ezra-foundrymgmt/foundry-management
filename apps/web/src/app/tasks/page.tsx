"use client";
import { useEffect, useState } from "react";
import { WORK_PRIORITIES, creators, tasks as seededTasks, type Task } from "@creatoros/domain";
import { Filter } from "lucide-react";
import { DemoStrip, PageHeader } from "@/components/page-header";
import { useDemoMode } from "@/components/mode-provider";
import { StatusBadge } from "@/components/status-badge";
import {
  TaskCreateForm,
  type CreatedTask,
  type TaskCreatorOption,
} from "@/components/task-create-form";

export default function TasksPage() {
  type DisplayTask = Task & { creatorName?: string; updatedAt?: string };
  const demo = useDemoMode();
  const [tasks, setTasks] = useState<DisplayTask[]>(demo ? seededTasks : []);
  const [creatorOptions, setCreatorOptions] = useState<TaskCreatorOption[]>([]);
  const [team, setTeam] = useState<Array<{ id: string; name: string }>>([]);
  const [message, setMessage] = useState("");
  useEffect(() => {
    if (!demo)
      void fetch("/api/tasks")
        .then((response) => response.json())
        .then((body: { data?: DisplayTask[]; creators?: TaskCreatorOption[]; team?: Array<{ id: string; name: string }> }) => {
          setTasks(body.data ?? []);
          setCreatorOptions(body.creators ?? []);
          setTeam(body.team ?? []);
        });
  }, [demo]);
  type PatchResult = { status?: Task["status"]; priority?: Task["priority"]; updatedAt?: string };

  /**
   * Shared by `advance` (status) and `reprioritise` (priority): both PATCH the
   * same endpoint with the row's own `updatedAt` as a concurrency token, and
   * both need the same demo-mode short-circuit, error surfacing, and
   * merge-the-response-back-into-state handling. Kept as one function so the
   * two callers can't drift into different behavior for the same failure — a
   * stale write refused by the server reads the same way regardless of which
   * field someone was changing.
   */
  const patchTask = async (
    task: DisplayTask,
    body: { status: Task["status"] } | { priority: Task["priority"] },
    toPatch: (result: PatchResult) => Partial<DisplayTask> | null,
    fallbackErrorMessage: string,
  ) => {
    if (demo || !task.updatedAt) {
      setTasks((current) =>
        current.map((item) => (item.id === task.id ? { ...item, ...body } : item)),
      );
      return;
    }
    const response = await fetch(`/api/tasks/${task.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...body, updatedAt: task.updatedAt }),
    });
    const result = (await response.json()) as PatchResult & { error?: string };
    const patch = response.ok ? toPatch(result) : null;
    if (!patch || !result.updatedAt) {
      setMessage(
        result.error === "TASK_CHANGED_REFRESH_REQUIRED"
          ? "Someone else changed that task first. Reload before trying again."
          : (result.error ?? fallbackErrorMessage),
      );
      return;
    }
    const updatedAt = result.updatedAt;
    setTasks((current) =>
      current.map((item) => (item.id === task.id ? { ...item, ...patch, updatedAt } : item)),
    );
  };

  const advance = (task: DisplayTask) => {
    const status = task.status === "OPEN" ? "IN_PROGRESS" : "DONE";
    return patchTask(task, { status }, (r) => (r.status ? { status: r.status } : null), "Task update failed");
  };

  /**
   * Re-triages a task. The row's own `updatedAt` goes back with the write, so a
   * change made from a stale view is refused rather than silently overwriting
   * whoever got there first.
   */
  const reprioritise = (task: DisplayTask, priority: string) =>
    patchTask(
      task,
      { priority: priority as Task["priority"] },
      (r) => (r.priority ? { priority: r.priority } : null),
      "Task priority update failed",
    );

  const onCreated = (created: CreatedTask) => {
    setTasks((current) => [
      {
        id: created.id,
        creatorId: created.creator_id,
        title: created.title,
        department: (created.department ?? "Operations") as Task["department"],
        priority: (created.priority ?? "MEDIUM") as Task["priority"],
        status: created.status as Task["status"],
        owner: "Unassigned",
        dueAt: created.due_at ? new Date(created.due_at).toLocaleDateString() : "Unscheduled",
        sourceType: "MANUAL",
        sourceId: null,
        creatorName:
          creatorOptions.find((option) => option.id === created.creator_id)?.name ?? "Foundry",
        updatedAt: created.updated_at,
      },
      ...current,
    ]);
  };

  return (
    <main className="page">
      <DemoStrip />
      <PageHeader
        eyebrow="Execution"
        title="Tasks"
        subtitle="Internal work linked to creators, reports, prospects, and workflow runs."
        actions={
          demo ? (
            <button
              className="button primary"
              disabled
              title="Creating tasks writes to the live database"
            >
              Create task
            </button>
          ) : (
            <TaskCreateForm creators={creatorOptions} team={team} onCreated={onCreated} />
          )
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
                      <select
                        className="input"
                        aria-label={`Priority for ${task.title}`}
                        value={task.priority}
                        onChange={(event) => void reprioritise(task, event.target.value)}
                      >
                        {/*
                          A row written before priority was constrained to
                          WORK_PRIORITIES (the GET route's "NORMAL" fallback for a
                          null value, or an older report recommendation) holds a
                          value with no matching option below. A controlled
                          <select> with no matching option silently falls back to
                          the first one in DOM order, misrepresenting the task's
                          real priority on the one page whose purpose is triage —
                          so that value gets its own option instead of being
                          swallowed.
                        */}
                        {!(WORK_PRIORITIES as readonly string[]).includes(task.priority) ? (
                          <option value={task.priority}>{task.priority}</option>
                        ) : null}
                        {WORK_PRIORITIES.map((level) => (
                          <option key={level} value={level}>
                            {level}
                          </option>
                        ))}
                      </select>
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
