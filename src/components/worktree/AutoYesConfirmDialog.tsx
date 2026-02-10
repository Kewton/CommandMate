/**
 * AutoYesConfirmDialog - Confirmation dialog for enabling auto-yes mode
 *
 * Displays a warning message, risk explanation, disclaimer,
 * and duration selection radio buttons before enabling auto-yes mode.
 *
 * Issue #225: Added duration selection (1h/3h/8h)
 */

'use client';

import React, { useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import {
  ALLOWED_DURATIONS,
  DEFAULT_AUTO_YES_DURATION,
  DURATION_LABELS,
  type AutoYesDuration,
} from '@/config/auto-yes-config';

/** Props for AutoYesConfirmDialog component */
export interface AutoYesConfirmDialogProps {
  /** Whether the dialog is open */
  isOpen: boolean;
  /** Callback when user confirms enabling auto-yes with selected duration */
  onConfirm: (duration: AutoYesDuration) => void;
  /** Callback when user cancels */
  onCancel: () => void;
  /** Name of the CLI tool Auto Yes will target */
  cliToolName?: string;
}

export function AutoYesConfirmDialog({
  isOpen,
  onConfirm,
  onCancel,
  cliToolName,
}: AutoYesConfirmDialogProps) {
  const [selectedDuration, setSelectedDuration] = useState<AutoYesDuration>(DEFAULT_AUTO_YES_DURATION);

  return (
    <Modal
      isOpen={isOpen}
      onClose={onCancel}
      title={`Auto Yesモードを有効にしますか？${cliToolName ? `（${cliToolName}）` : ''}`}
      size="sm"
      showCloseButton={true}
    >
      <div className="space-y-4">
        <div className="text-sm text-gray-700">
          <p className="font-medium mb-2">機能説明</p>
          <ul className="list-disc list-inside space-y-1">
            <li>yes/no確認 → 自動で「yes」を送信</li>
            <li>複数選択肢 → デフォルトまたは先頭の選択肢を自動選択</li>
          </ul>
          <p className="mt-1">{DURATION_LABELS[selectedDuration]}後に自動でOFFになります。</p>
          {cliToolName && (
            <p className="mt-2 text-gray-500">
              ※ Auto Yesは現在選択中の <span className="font-medium text-gray-700">{cliToolName}</span> セッションのみに適用されます。
              他のCLIツールには影響しません。
            </p>
          )}
        </div>

        {/* Duration selection - horizontal button group */}
        <div className="text-sm text-gray-700">
          <p className="font-medium mb-2">有効時間</p>
          <div className="flex gap-2">
            {ALLOWED_DURATIONS.map((duration) => (
              <button
                key={duration}
                type="button"
                onClick={() => setSelectedDuration(duration)}
                className={`flex-1 py-2 px-3 text-sm font-medium rounded-md border-2 transition-colors ${
                  selectedDuration === duration
                    ? 'border-blue-600 bg-blue-50 text-blue-700'
                    : 'border-gray-300 bg-white text-gray-700 hover:border-gray-400'
                }`}
                style={{ minHeight: '44px' }}
              >
                {DURATION_LABELS[duration]}
              </button>
            ))}
          </div>
        </div>

        <div className="text-sm text-gray-700">
          <p className="font-medium mb-2">リスクについて</p>
          <p>
            自動応答により、意図しない操作（ファイルの削除・上書き等）が
            実行される可能性があります。内容を十分に理解した上でご利用ください。
          </p>
        </div>

        <div className="bg-yellow-50 border-l-4 border-yellow-400 p-3">
          <p className="text-sm text-yellow-800">
            <span className="font-medium">免責事項：</span>
            Auto Yesモードの使用により発生した問題について、
            開発者は一切の責任を負いません。自己責任でご利用ください。
          </p>
        </div>

        <div className="flex justify-end gap-3 pt-2">
          <button
            type="button"
            onClick={onCancel}
            className="px-4 py-2 text-sm font-medium rounded-md bg-gray-200 hover:bg-gray-300 text-gray-700"
          >
            キャンセル
          </button>
          <button
            type="button"
            onClick={() => onConfirm(selectedDuration)}
            className="px-4 py-2 text-sm font-medium rounded-md bg-yellow-600 hover:bg-yellow-700 text-white"
          >
            同意して有効化
          </button>
        </div>
      </div>
    </Modal>
  );
}

export default AutoYesConfirmDialog;
