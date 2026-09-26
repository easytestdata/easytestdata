import { Info } from "lucide-react";
import { Label } from "../ui/label";
import { Tooltip, TooltipTrigger, TooltipContent } from "../ui/tooltip";

interface FieldLabelProps {
  htmlFor?: string;
  children: React.ReactNode;
  hint?: string;
  className?: string;
}

export function FieldLabel({ htmlFor, children, hint, className }: FieldLabelProps) {
  return (
    <div className="flex items-center gap-1.5">
      <Label htmlFor={htmlFor} className={className}>
        {children}
      </Label>
      {hint && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Info className="h-3.5 w-3.5 text-muted-foreground cursor-help shrink-0" />
          </TooltipTrigger>
          <TooltipContent side="top" className="max-w-[240px]">
            {hint}
          </TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}
