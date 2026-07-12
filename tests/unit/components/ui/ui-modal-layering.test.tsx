/**
 * Edge case (Issue #1046): overlay primitives opened inside a Modal must layer
 * above it. Radix propagates the content's z-index onto the positioned popper
 * wrapper, which must exceed Z_INDEX.MODAL so the surface is not clipped.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { Modal } from '@/components/ui/Modal';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/Select';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/Tooltip';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/DropdownMenu';
import { Z_INDEX } from '@/config/z-index';
import { installRadixJsdomPolyfills } from '@tests/helpers/radix-jsdom';

beforeAll(() => installRadixJsdomPolyfills());
afterEach(() => {
  cleanup();
  document.body.style.overflow = 'unset';
});

/** Read the z-index Radix applied to the positioned popper wrapper. */
function popperWrapperZIndex(): number {
  const wrapper = document.querySelector('[data-radix-popper-content-wrapper]');
  expect(wrapper).not.toBeNull();
  return Number((wrapper as HTMLElement).style.zIndex);
}

describe('overlay primitives inside a Modal', () => {
  it('layers an open Select above the modal', () => {
    render(
      <Modal isOpen onClose={() => {}} title="Dialog">
        <Select defaultValue="a" defaultOpen>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="a">A</SelectItem>
          </SelectContent>
        </Select>
      </Modal>
    );
    expect(popperWrapperZIndex()).toBe(Z_INDEX.POPOVER);
    expect(popperWrapperZIndex()).toBeGreaterThan(Z_INDEX.MODAL);
  });

  it('layers an open Tooltip above the modal', () => {
    render(
      <Modal isOpen onClose={() => {}} title="Dialog">
        <TooltipProvider delayDuration={0}>
          <Tooltip defaultOpen>
            <TooltipTrigger>info</TooltipTrigger>
            <TooltipContent>hint</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </Modal>
    );
    expect(popperWrapperZIndex()).toBe(Z_INDEX.POPOVER);
    expect(popperWrapperZIndex()).toBeGreaterThan(Z_INDEX.MODAL);
  });

  it('layers an open DropdownMenu above the modal', () => {
    render(
      <Modal isOpen onClose={() => {}} title="Dialog">
        <DropdownMenu defaultOpen>
          <DropdownMenuTrigger>menu</DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem>item</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </Modal>
    );
    expect(popperWrapperZIndex()).toBe(Z_INDEX.POPOVER);
    expect(popperWrapperZIndex()).toBeGreaterThan(Z_INDEX.MODAL);
  });
});
