/**
 * ReportDatePicker Component
 * Date selector with previous/next day navigation buttons.
 *
 * Issue #607: Daily summary feature
 */

'use client';

import { useTranslations } from 'next-intl';
import { Button, Input } from '@/components/ui';

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
  const t = useTranslations('review');
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
      <Button
        variant="secondary"
        size="sm"
        onClick={handlePrev}
        data-testid="date-prev"
        aria-label={t('datePicker.previousDay')}
      >
        &lt;
      </Button>
      <Input
        type="date"
        inputSize="sm"
        value={value}
        max={today}
        onChange={(e) => onChange(e.target.value)}
        className="w-auto"
        data-testid="date-input"
      />
      <Button
        variant="secondary"
        size="sm"
        onClick={handleNext}
        disabled={isToday}
        data-testid="date-next"
        aria-label={t('datePicker.nextDay')}
      >
        &gt;
      </Button>
    </div>
  );
}
