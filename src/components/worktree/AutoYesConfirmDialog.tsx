/**
 * AutoYesConfirmDialog - Confirmation dialog for enabling auto-yes mode
 *
 * Displays a warning message, risk explanation, and disclaimer
 * before enabling auto-yes mode.
 */

'use client';

import React from 'react';
import { Modal } from '@/components/ui/Modal';

/** Props for AutoYesConfirmDialog component */
export interface AutoYesConfirmDialogProps {
  /** Whether the dialog is open */
  isOpen: boolean;
  /** Callback when user confirms enabling auto-yes */
  onConfirm: () => void;
  /** Callback when user cancels */
  onCancel: () => void;
}

export function AutoYesConfirmDialog({
  isOpen,
  onConfirm,
  onCancel,
}: AutoYesConfirmDialogProps) {
  return (
    <Modal
      isOpen={isOpen}
      onClose={onCancel}
      title="Auto Yesモードを有効にしますか？"
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
          <p className="mt-1">1時間後に自動でOFFになります。</p>
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
            onClick={onConfirm}
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
