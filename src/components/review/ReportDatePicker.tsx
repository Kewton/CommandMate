/**
 * ReportDatePicker Component
 * Date selector with previous/next day navigation buttons.
 *
 * Issue #607: Daily summary feature
 */

'use client';

interface ReportDatePickerProps {
  value: string; // YYYY-MM-DD
  onChange: (date: string) => void;
}

/** Format Date to YYYY-MM-DD */
function formatDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Get today's date string in YYYY-MM-DD */
function getToday(): string {
  return formatDate(new Date());
}

export default function ReportDatePicker({ value, onChange }: ReportDatePickerProps) {
  const today = getToday();
  const isToday = value === today;

  const handlePrev = () => {
    const d = new Date(value + 'T00:00:00');
    d.setDate(d.getDate() - 1);
    onChange(formatDate(d));
  };

  const handleNext = () => {
    if (isToday) return;
    const d = new Date(value + 'T00:00:00');
    d.setDate(d.getDate() + 1);
    const next = formatDate(d);
    // Do not go beyond today
    if (next > today) return;
    onChange(next);
  };

  return (
    <div className="flex items-center gap-2" data-testid="report-date-picker">
      <button
        onClick={handlePrev}
        className="px-2 py-1 text-sm rounded bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-300"
        data-testid="date-prev"
        aria-label="Previous day"
      >
        &lt;
      </button>
      <input
        type="date"
        value={value}
        max={today}
        onChange={(e) => onChange(e.target.value)}
        className="px-3 py-1 text-sm border rounded dark:bg-gray-800 dark:border-gray-700 dark:text-gray-200"
        data-testid="date-input"
      />
      <button
        onClick={handleNext}
        disabled={isToday}
        className={`px-2 py-1 text-sm rounded ${
          isToday
            ? 'bg-gray-50 dark:bg-gray-900 text-gray-400 dark:text-gray-600 cursor-not-allowed'
            : 'bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-300'
        }`}
        data-testid="date-next"
        aria-label="Next day"
      >
        &gt;
      </button>
    </div>
  );
}
