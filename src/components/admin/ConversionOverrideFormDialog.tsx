import { useEffect, useMemo } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  CONFIDENCE_VALUES,
  INTENT_VALUES,
  NOTE_REQUIRED_SCOPES,
  SCOPE_TYPES,
  conversionOverrideFormSchema,
  decimalToPct,
  parseNumberOrNull,
  pctToDecimal,
  type ConversionOverrideFormValues,
  type ScopeType,
} from "@/lib/validation/conversionOverride";
import {
  useUpsertConversionOverride,
  type ConversionOverrideWithActor,
} from "@/hooks/useConversionOverrides";

type Props = {
  projectId: string;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  editing?: ConversionOverrideWithActor | null;
};

export default function ConversionOverrideFormDialog({
  projectId,
  open,
  onOpenChange,
  editing,
}: Props) {
  const upsert = useUpsertConversionOverride(projectId);

  const defaults = useMemo<ConversionOverrideFormValues>(
    () => ({
      scope_type: (editing?.scope_type ?? "project") as ScopeType,
      scope_value: editing?.scope_value ?? "",
      conversion_rate_pct: decimalToPct(editing?.conversion_rate ?? null),
      average_order_value:
        editing?.average_order_value != null ? String(editing.average_order_value) : "",
      confidence: (editing?.confidence as any) ?? "medium",
      note: editing?.note ?? "",
    }),
    [editing],
  );

  const form = useForm<ConversionOverrideFormValues>({
    resolver: zodResolver(conversionOverrideFormSchema),
    defaultValues: defaults,
  });

  useEffect(() => {
    if (open) form.reset(defaults);
  }, [open, defaults, form]);

  const scopeType = form.watch("scope_type");
  const noteRequired = NOTE_REQUIRED_SCOPES.includes(scopeType);

  const onSubmit = form.handleSubmit(async (values) => {
    try {
      await upsert.mutateAsync({
        id: editing?.id,
        project_id: projectId,
        scope_type: values.scope_type,
        scope_value: values.scope_type === "project" ? null : values.scope_value || null,
        conversion_rate: pctToDecimal(values.conversion_rate_pct),
        average_order_value: parseNumberOrNull(values.average_order_value),
        confidence: values.confidence,
        note: values.note || null,
      });
      toast.success(editing ? "Override updated" : "Override created");
      onOpenChange(false);
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      if (msg.includes("duplicate") || msg.includes("23505")) {
        toast.error("An override already exists for this scope and value");
      } else {
        toast.error(`Save failed: ${msg}`);
      }
    }
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{editing ? "Edit override" : "New conversion override"}</DialogTitle>
          <DialogDescription>
            Overrides apply to Revenue v2 forecasts only. They have no effect until v2
            visibility is enabled. v1 forecasts are unchanged.
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={onSubmit} className="space-y-4">
            <FormField
              control={form.control}
              name="scope_type"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Scope</FormLabel>
                  <Select value={field.value} onValueChange={field.onChange}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {SCOPE_TYPES.map((s) => (
                        <SelectItem key={s} value={s} className="capitalize">
                          {s}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />

            {scopeType !== "project" && (
              <FormField
                control={form.control}
                name="scope_value"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      {scopeType === "url"
                        ? "URL"
                        : scopeType === "category"
                          ? "Category"
                          : "Intent"}
                    </FormLabel>
                    {scopeType === "intent" ? (
                      <Select value={field.value} onValueChange={field.onChange}>
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="Select intent" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {INTENT_VALUES.map((i) => (
                            <SelectItem key={i} value={i} className="capitalize">
                              {i}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : (
                      <FormControl>
                        <Input
                          {...field}
                          placeholder={
                            scopeType === "url"
                              ? "https://example.com/page"
                              : "e.g. Refurbished > Laptops"
                          }
                        />
                      </FormControl>
                    )}
                    <FormMessage />
                  </FormItem>
                )}
              />
            )}

            <div className="grid grid-cols-2 gap-3">
              <FormField
                control={form.control}
                name="conversion_rate_pct"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Conversion rate (%)</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        step="0.01"
                        min={0}
                        max={100}
                        placeholder="e.g. 2.5"
                        {...field}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="average_order_value"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Average order value</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        step="0.01"
                        min={0}
                        placeholder="e.g. 120"
                        {...field}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <FormField
              control={form.control}
              name="confidence"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Confidence</FormLabel>
                  <Select value={field.value} onValueChange={field.onChange}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {CONFIDENCE_VALUES.map((c) => (
                        <SelectItem key={c} value={c} className="capitalize">
                          {c}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="note"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>
                    Note {noteRequired ? <span className="text-destructive">*</span> : (
                      <span className="text-muted-foreground text-xs font-normal">
                        (optional)
                      </span>
                    )}
                  </FormLabel>
                  <FormControl>
                    <Textarea rows={3} placeholder="Rationale for this override" {...field} />
                  </FormControl>
                  {noteRequired && (
                    <FormDescription>
                      Required for URL and category overrides because these assumptions can
                      materially change forecasts.
                    </FormDescription>
                  )}
                  <FormMessage />
                </FormItem>
              )}
            />

            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                onClick={() => onOpenChange(false)}
                disabled={upsert.isPending}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={upsert.isPending}>
                {upsert.isPending ? "Saving…" : editing ? "Save changes" : "Create override"}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
