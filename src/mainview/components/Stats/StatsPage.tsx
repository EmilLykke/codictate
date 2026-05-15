import { useMemo, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { motion } from "motion/react";
import type {
  AppSettings,
  StatsRange,
  StatsSummary,
} from "../../../shared/types";
import { fetchStats, updateStatsSettings } from "../../rpc";
import { InstantTooltip } from "../Common/InstantTooltip";
import { DropdownSelect } from "../Common/DropdownSelect";

const CARD =
  "rounded-2xl bg-surface-1 border border-overlay/14 p-7 flex flex-col";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

const RANGE_OPTIONS: { value: StatsRange; label: string }[] = [
  { value: "today", label: "Today" },
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" },
  { value: "3m", label: "3 months" },
  { value: "all", label: "All time" },
];

function formatNumber(n: number): string {
  return n.toLocaleString();
}

function PeriodTrend({
  current,
  previous,
}: {
  current: number;
  previous: number;
}) {
  if (previous === 0 && current === 0) return null;
  if (!previous)
    return (
      <span className="text-[13px] text-green-400/70 font-medium">New</span>
    );

  const pct = Math.round(((current - previous) / previous) * 100);
  const isUp = pct >= 0;

  return (
    <span
      className={`text-[11px] font-medium whitespace-nowrap ${
        isUp ? "text-green-400/60" : "text-red-400/60"
      }`}
    >
      {isUp ? "+" : ""}
      {pct}%
    </span>
  );
}

function rangeToDays(range: StatsRange): number {
  switch (range) {
    case "today":
      return 7;
    case "7d":
      return 7;
    case "30d":
      return 30;
    case "3m":
      return 91;
    case "all": {
      const now = new Date();
      const yearStart = new Date(now.getFullYear(), 0, 1);
      return (
        Math.ceil(
          (now.getTime() - yearStart.getTime()) / (1000 * 60 * 60 * 24),
        ) + 1
      );
    }
  }
}

function StreakHeatmap({
  dailyActivity,
  currentStreak,
  longestStreak,
  range,
}: {
  dailyActivity: Record<string, number>;
  currentStreak: number;
  longestStreak: number;
  range: StatsRange;
}) {
  const { weeks, monthLabels, maxWords } = useMemo(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const days = rangeToDays(range);
    const totalWeeks = Math.max(2, Math.ceil(days / 7));

    const end = new Date(today);
    end.setDate(end.getDate() + (6 - end.getDay()));
    const start = new Date(end);
    start.setDate(start.getDate() - totalWeeks * 7 + 1);

    const mw = Math.max(1, ...Object.values(dailyActivity));

    const allWeeks: { date: Date; words: number; key: string }[][] = [];
    const cursor = new Date(start);
    let currentWeek: { date: Date; words: number; key: string }[] = [];

    while (cursor <= end) {
      const key = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, "0")}-${String(cursor.getDate()).padStart(2, "0")}`;
      currentWeek.push({
        date: new Date(cursor),
        words: dailyActivity[key] ?? 0,
        key,
      });
      if (currentWeek.length === 7) {
        allWeeks.push(currentWeek);
        currentWeek = [];
      }
      cursor.setDate(cursor.getDate() + 1);
    }
    if (currentWeek.length > 0) allWeeks.push(currentWeek);

    const labels: { label: string; weekIndex: number }[] = [];
    let lastMonth = -1;
    for (let w = 0; w < allWeeks.length; w++) {
      const firstDay = allWeeks[w][0];
      const month = firstDay.date.getMonth();
      if (month !== lastMonth) {
        labels.push({
          label: firstDay.date.toLocaleString("default", { month: "short" }),
          weekIndex: w,
        });
        lastMonth = month;
      }
    }

    return { weeks: allWeeks, monthLabels: labels, maxWords: mw };
  }, [dailyActivity, range]);

  const isFuture = (d: Date) => d > new Date();

  const todayKey = useMemo(() => {
    const t = new Date();
    return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
  }, []);

  function cellColor(words: number, date: Date): string {
    if (isFuture(date)) return "bg-transparent";
    if (words === 0) return "bg-surface-3";
    const intensity = words / maxWords;
    if (intensity > 0.75) return "bg-accent-blue/80";
    if (intensity > 0.5) return "bg-accent-blue/55";
    if (intensity > 0.25) return "bg-accent-blue/35";
    return "bg-accent-blue/18";
  }

  return (
    <div className={`${CARD} gap-5`}>
      <div className="flex items-baseline justify-between">
        <div className="flex items-baseline gap-2.5">
          <span className="text-[28px] font-semibold text-overlay/90 leading-tight">
            {currentStreak} day{currentStreak !== 1 ? "s" : ""}
          </span>
          <span className="text-[14px] text-overlay/40">streak</span>
        </div>
        <span className="text-[12px] font-semibold uppercase tracking-[0.1em] text-overlay/35">
          Longest: {longestStreak} days
        </span>
      </div>

      <div className="flex gap-1">
        <div className="flex flex-col gap-1 mr-1.5 pt-5">
          {WEEKDAYS.map((d, i) => (
            <div
              key={d}
              className={`text-[10px] text-overlay/30 h-[14px] flex items-center ${i % 2 === 0 ? "" : "invisible"}`}
            >
              {d}
            </div>
          ))}
        </div>
        <div className="flex-1 overflow-x-auto overflow-y-visible scrollbar-hidden">
          <div className="flex gap-1 mb-1.5 min-h-[16px]">
            {monthLabels.map((m) => (
              <div
                key={`${m.label}-${m.weekIndex}`}
                className="text-[10px] text-overlay/30"
                style={{
                  marginLeft: m.weekIndex === 0 ? 0 : undefined,
                  position: "relative",
                  left: `${m.weekIndex * 18}px`,
                }}
              >
                {m.label}
              </div>
            ))}
          </div>
          <div className="flex gap-[3px]">
            {weeks.map((week, wi) => (
              <div key={wi} className="flex flex-col gap-[3px]">
                {week.map((day) =>
                  isFuture(day.date) ? (
                    <div
                      key={day.key}
                      className="w-[14px] h-[14px] rounded-[3px] bg-transparent"
                    />
                  ) : (
                    <InstantTooltip
                      key={day.key}
                      side="bottom"
                      disableHoverableContent
                      text={
                        <span className="whitespace-nowrap">
                          <span className="font-medium text-overlay/80">
                            {day.words === 0
                              ? "No dictations"
                              : `${formatNumber(day.words)} word${day.words !== 1 ? "s" : ""}`}
                          </span>
                          <br />
                          <span className="text-[11px] text-overlay/40">
                            {day.date.toLocaleDateString("default", {
                              weekday: "short",
                              month: "short",
                              day: "numeric",
                            })}
                          </span>
                        </span>
                      }
                    >
                      <div
                        className={`w-[14px] h-[14px] rounded-[3px] cursor-pointer ${cellColor(day.words, day.date)} ${range === "today" && day.key === todayKey ? "ring-2 ring-accent-blue/60 ring-offset-1 ring-offset-codictate-page" : ""}`}
                      />
                    </InstantTooltip>
                  ),
                )}
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="flex items-center gap-2 text-[10px] text-overlay/30">
        <span>Less</span>
        <div className="flex gap-[3px]">
          <div className="w-[12px] h-[12px] rounded-[2px] bg-surface-3" />
          <div className="w-[12px] h-[12px] rounded-[2px] bg-accent-blue/18" />
          <div className="w-[12px] h-[12px] rounded-[2px] bg-accent-blue/35" />
          <div className="w-[12px] h-[12px] rounded-[2px] bg-accent-blue/55" />
          <div className="w-[12px] h-[12px] rounded-[2px] bg-accent-blue/80" />
        </div>
        <span>More</span>
      </div>
    </div>
  );
}

function StatsEnabled({
  stats,
  range,
}: {
  stats: StatsSummary;
  range: StatsRange;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
      className="flex flex-col gap-6"
    >
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className={`${CARD} gap-1`}>
          <div className="flex items-baseline justify-between">
            <span className="text-[36px] font-semibold text-overlay/90 leading-tight">
              {formatNumber(stats.totalOutputWords)}
            </span>
            <PeriodTrend
              current={stats.trendCurrentWords}
              previous={stats.trendPreviousWords}
            />
          </div>
          <span className="text-[12px] font-semibold uppercase tracking-[0.1em] text-overlay/35">
            Total words dictated
          </span>
        </div>

        <div className={`${CARD} gap-1`}>
          <div className="flex items-baseline gap-2.5">
            <span className="text-[36px] font-semibold text-overlay/90 leading-tight">
              {stats.averageRawWpm}
            </span>
            <span className="text-[16px] font-semibold text-overlay/40 leading-tight">
              WPM
            </span>
          </div>
          <span className="text-[12px] font-semibold uppercase tracking-[0.1em] text-overlay/35">
            Words per minute
          </span>
        </div>

        <div className={`${CARD} gap-1`}>
          <div className="flex items-baseline gap-2.5">
            <span className="text-[36px] font-semibold text-overlay/90 leading-tight">
              {formatNumber(stats.totalSessions)}
            </span>
          </div>
          <span className="text-[12px] font-semibold uppercase tracking-[0.1em] text-overlay/35">
            Total dictations
          </span>
        </div>
      </div>

      <StreakHeatmap
        dailyActivity={stats.dailyActivity}
        currentStreak={stats.currentStreakDays}
        longestStreak={stats.longestStreakDays}
        range={range}
      />
    </motion.div>
  );
}

function StatsDisabled({ onEnable }: { onEnable: () => void }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
      className="flex flex-col items-center justify-center gap-4 py-24"
    >
      <div className="text-overlay/30">
        <svg
          width="48"
          height="48"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M3 3v18h18" />
          <path d="M18 17V9" />
          <path d="M13 17V5" />
          <path d="M8 17v-3" />
        </svg>
      </div>
      <span className="text-[17px] font-medium text-overlay/50">
        Stats are disabled
      </span>
      <span className="text-[14px] text-overlay/30 text-center max-w-[300px]">
        Enable to track word count, speaking speed, and streaks. No transcript
        text is stored.
      </span>
      <button
        type="button"
        onClick={onEnable}
        className="mt-2 px-5 py-2 rounded-lg bg-accent-blue/15 border border-accent-blue/25 text-[14px] font-medium text-accent-blue/80 hover:bg-accent-blue/25 transition-colors cursor-pointer"
      >
        Enable stats
      </button>
    </motion.div>
  );
}

export function StatsPage({
  settings,
  onOpenStatsSettings,
}: {
  settings: AppSettings;
  onOpenStatsSettings: () => void;
}) {
  const statsEnabled = settings.stats?.enabled ?? false;
  const [range, setRange] = useState<StatsRange>("all");

  const { data: stats } = useQuery({
    queryKey: ["stats", range],
    queryFn: () => fetchStats(range),
    enabled: statsEnabled,
    placeholderData: keepPreviousData,
  });

  const handleEnable = async () => {
    await updateStatsSettings({ enabled: true });
  };

  return (
    <div className="max-w-5xl">
      <div className="flex items-center justify-between mb-8">
        <h2 className="text-[28px] font-semibold text-overlay/90">Stats</h2>
        {statsEnabled && (
          <div className="flex items-center gap-4">
            <DropdownSelect
              value={range}
              onChange={(v) => setRange(v as StatsRange)}
              ariaLabel="Time range"
              options={RANGE_OPTIONS}
            />
            <button
              type="button"
              onClick={onOpenStatsSettings}
              className="text-[13px] text-overlay/35 hover:text-overlay/60 transition-colors cursor-pointer"
            >
              Settings
            </button>
          </div>
        )}
      </div>

      {statsEnabled && stats ? (
        <StatsEnabled stats={stats} range={range} />
      ) : statsEnabled ? (
        <div className="flex items-center justify-center py-24">
          <motion.div
            animate={{ opacity: [0.2, 0.5, 0.2] }}
            transition={{ duration: 1.6, repeat: Infinity, ease: "easeInOut" }}
            className="w-1.5 h-1.5 rounded-full bg-surface-4"
          />
        </div>
      ) : (
        <StatsDisabled onEnable={handleEnable} />
      )}
    </div>
  );
}
