import React from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Input } from "@/components/ui/input";

export const ConfirmDialog = ({ open, onOpenChange, title, description, confirmLabel = "Confirm", destructive = false, onConfirm, loading = false, testId = "confirm-dialog", confirmText }) => {
  const [typed, setTyped] = React.useState("");
  React.useEffect(() => {
    if (!open) setTyped("");
  }, [open]);
  const blocked = !!confirmText && typed.trim() !== confirmText;
  return (
  <AlertDialog open={open} onOpenChange={onOpenChange}>
    <AlertDialogContent className="rounded-card" data-testid={testId}>
      <AlertDialogHeader>
        <AlertDialogTitle>{title}</AlertDialogTitle>
        {description ? <AlertDialogDescription>{description}</AlertDialogDescription> : null}
      </AlertDialogHeader>
      {confirmText ? (
        <div className="px-1">
          <Input
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder={confirmText}
            autoComplete="off"
            className="font-mono"
            aria-label={`Type ${confirmText} to confirm`}
            data-testid="confirm-type"
          />
        </div>
      ) : null}
      <AlertDialogFooter>
        <AlertDialogCancel data-testid="confirm-cancel">Cancel</AlertDialogCancel>
        <AlertDialogAction
          data-testid="confirm-accept"
          disabled={loading || blocked}
          onClick={(e) => {
            e.preventDefault();
            if (blocked) return;
            onConfirm && onConfirm();
          }}
          className={destructive ? "bg-vl-danger hover:bg-[#a94545] text-white" : ""}
        >
          {loading ? "Working…" : confirmLabel}
        </AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
  );
};
