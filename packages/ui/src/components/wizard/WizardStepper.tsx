import { Check } from "lucide-react";
import { cn } from "../../lib/utils";

interface Step {
  label: string;
  description?: string;
}

interface WizardStepperProps {
  steps: Step[];
  currentStep: number;
}

export function WizardStepper({ steps, currentStep }: WizardStepperProps) {
  return (
    <div className="flex items-center justify-center gap-0">
      {steps.map((step, index) => {
        const isCompleted = index < currentStep;
        const isCurrent = index === currentStep;
        return (
          <div key={index} className="flex items-center">
            {/* Step circle + label */}
            <div className="flex flex-col items-center gap-1.5">
              <div
                className={cn(
                  "flex h-9 w-9 items-center justify-center rounded-full text-sm font-semibold transition-colors",
                  isCompleted && "bg-gradient-to-br from-blue-600 to-cyan-500 text-white shadow-md shadow-blue-500/20",
                  isCurrent && "border-2 border-primary bg-primary/10 text-primary shadow-md shadow-blue-500/20",
                  !isCompleted && !isCurrent && "border-2 border-muted bg-muted/50 text-muted-foreground"
                )}
              >
                {isCompleted ? <Check className="h-4 w-4" /> : index + 1}
              </div>
              <div className="text-center">
                <p
                  className={cn(
                    "text-xs font-medium",
                    isCurrent ? "text-primary" : isCompleted ? "text-foreground" : "text-muted-foreground"
                  )}
                >
                  {step.label}
                </p>
                {step.description && (
                  <p className="text-[10px] text-muted-foreground">{step.description}</p>
                )}
              </div>
            </div>

            {/* Connector line */}
            {index < steps.length - 1 && (
              <div
                className={cn(
                  "mx-3 mb-6 h-0.5 w-12 sm:w-20",
                  index < currentStep
                    ? "bg-gradient-to-r from-blue-600 to-cyan-500"
                    : "bg-muted"
                )}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
