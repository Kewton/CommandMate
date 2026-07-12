/**
 * UI Components Index
 * Exports all reusable UI components
 */

export { Button } from './Button';
export type { ButtonProps, ButtonVariant, ButtonSize } from './Button';

export { Card, CardHeader, CardTitle, CardContent, CardFooter } from './Card';
export type { CardProps, CardHeaderProps, CardTitleProps, CardContentProps, CardFooterProps } from './Card';

export { Badge } from './Badge';
export type { BadgeProps, BadgeVariant } from './Badge';

export { Modal } from './Modal';
export type { ModalProps } from './Modal';

// Radix-based primitives (Issue #1046)
export { Input, inputVariants } from './Input';
export type { InputProps } from './Input';

export { Textarea } from './Textarea';
export type { TextareaProps } from './Textarea';

export { Skeleton } from './Skeleton';
export type { SkeletonProps } from './Skeleton';

export { Switch } from './Switch';
export type { SwitchProps } from './Switch';

export { Tabs, TabsList, TabsTrigger, TabsContent } from './Tabs';
export type { TabsProps, TabsVariant } from './Tabs';

export {
  Select,
  SelectGroup,
  SelectValue,
  SelectTrigger,
  SelectContent,
  SelectLabel,
  SelectItem,
  SelectSeparator,
} from './Select';

export {
  Tooltip,
  TooltipProvider,
  TooltipTrigger,
  TooltipContent,
} from './Tooltip';

export {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuGroup,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
  DropdownMenuRadioItem,
  DropdownMenuRadioGroup,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from './DropdownMenu';
