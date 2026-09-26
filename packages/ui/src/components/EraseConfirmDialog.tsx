import { useState, useEffect } from "react";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from "./ui/alert-dialog";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

interface EraseConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
  pending?: boolean;
}

export function EraseConfirmDialog({
  open,
  onOpenChange,
  onConfirm,
  pending = false
}: EraseConfirmDialogProps) {
  const [input, setInput] = useState("");

  useEffect(() => {
    if (open) setInput("");
  }, [open]);

  const handleOpenChange = (nextOpen: boolean) => {
    if (pending && !nextOpen) return;
    onOpenChange(nextOpen);
  };

  return (
    <AlertDialog open={open} onOpenChange={handleOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Erase all data?</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2">
              <p>
                This permanently deletes <strong>every</strong> invoice, bill, payment and other
                transaction of the types EasyTestData loads, including ones you entered by hand,
                not just EasyTestData's. Customers,
                vendors, employees and items are made inactive (QuickBooks can't delete them).
                Accounts stay.
              </p>
              <p>
                Type <strong>ERASE</strong> below to confirm.
              </p>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <Input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder='Type "ERASE" to confirm'
          autoFocus
          disabled={pending}
        />
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <Button
            variant="destructive"
            disabled={pending || input !== "ERASE"}
            onClick={() => {
              onConfirm();
            }}
          >
            {pending ? "Starting..." : "Erase all data"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
