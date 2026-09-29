import { useMemo, useState } from "react";
import { Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import type { ProjectConversionCategory } from "@/integrations/gcp/admin-reference";

type Props = {
  categories: ProjectConversionCategory[];
  projectName?: string;
  value: string;
  onChange: (category: string) => void;
};

type SortOrder = "count" | "name";

function normalise(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

export default function ConversionCategoryPicker({ categories, projectName, value, onChange }: Props) {
  const [query, setQuery] = useState("");
  const [sortOrder, setSortOrder] = useState<SortOrder>("count");
  const selected = categories.find((category) => normalise(category.category) === normalise(value));

  const visibleCategories = useMemo(() => {
    const search = normalise(query);
    return categories
      .filter((category) => normalise(category.category).includes(search))
      .sort((left, right) =>
        sortOrder === "count"
          ? right.keywordCount - left.keywordCount || left.category.localeCompare(right.category)
          : left.category.localeCompare(right.category),
      );
  }, [categories, query, sortOrder]);

  const keywordCount = useMemo(
    () => categories.reduce((total, category) => total + category.keywordCount, 0),
    [categories],
  );
  const largestCount = categories.reduce(
    (largest, category) => Math.max(largest, category.keywordCount),
    1,
  );

  return (
    <div className="overflow-hidden rounded-lg border border-hairline bg-surface">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-hairline bg-surface-sunk px-3 py-2.5">
        <div>
          <p className="text-sm font-semibold">{projectName ? `${projectName} categories` : "Project categories"}</p>
          <p className="text-xs text-muted-foreground">
            {categories.length.toLocaleString()} individual {categories.length === 1 ? "category" : "categories"} · {keywordCount.toLocaleString()} kept keywords
          </p>
        </div>
        {selected && (
          <span className="rounded-md bg-signal-soft px-2 py-1 text-xs font-medium text-signal-ink">
            Selected: {selected.keywordCount.toLocaleString()} keywords
          </span>
        )}
      </div>

      <Command shouldFilter={false} className="rounded-none bg-transparent">
        <CommandInput
          aria-label="Search project categories"
          placeholder="Search category names…"
          value={query}
          onValueChange={setQuery}
        />
        <div className="flex items-center justify-between gap-2 border-b border-hairline px-3 py-2">
          <span className="text-xs text-muted-foreground">
            {visibleCategories.length.toLocaleString()} shown
          </span>
          <div className="flex gap-1" aria-label="Category sort order">
            <Button
              type="button"
              size="sm"
              variant={sortOrder === "count" ? "secondary" : "ghost"}
              className="h-7 px-2 text-xs"
              aria-pressed={sortOrder === "count"}
              onClick={() => setSortOrder("count")}
            >
              Most keywords
            </Button>
            <Button
              type="button"
              size="sm"
              variant={sortOrder === "name" ? "secondary" : "ghost"}
              className="h-7 px-2 text-xs"
              aria-pressed={sortOrder === "name"}
              onClick={() => setSortOrder("name")}
            >
              A–Z
            </Button>
          </div>
        </div>
        <CommandList className="max-h-64">
          <CommandEmpty>No categories match your search.</CommandEmpty>
          <CommandGroup className="p-1.5">
            {visibleCategories.map((category) => {
              const isSelected = selected?.category === category.category;
              return (
                <CommandItem
                  key={category.category}
                  value={category.category}
                  onSelect={() => onChange(category.category)}
                  className={`my-0.5 block rounded-md px-3 py-2.5 data-[selected=true]:!bg-surface-sunk data-[selected=true]:!text-foreground ${isSelected ? "ring-1 ring-inset ring-signal" : ""}`}
                >
                  <span className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate font-medium" title={category.category}>
                      {category.category}
                    </span>
                    <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
                      {category.keywordCount.toLocaleString()}
                    </span>
                    <Check className={`h-4 w-4 shrink-0 text-signal ${isSelected ? "" : "opacity-0"}`} />
                  </span>
                  <span className="mt-1.5 block h-1 overflow-hidden rounded-full bg-surface-sunk" aria-hidden="true">
                    <span
                      className="block h-full rounded-full bg-signal"
                      style={{ width: `${Math.max(2, (category.keywordCount / largestCount) * 100)}%` }}
                    />
                  </span>
                </CommandItem>
              );
            })}
          </CommandGroup>
        </CommandList>
      </Command>
      {categories.length === 1 && (
        <p className="border-t border-hairline bg-surface-sunk px-3 py-2.5 text-xs leading-5 text-ink-muted">
          All {keywordCount.toLocaleString()} kept keywords currently share “{categories[0].category}”.
          This is the only category available in this project; its override covers all of them before URL overrides.
        </p>
      )}
      <p className="border-t border-hairline px-3 py-2 text-xs text-muted-foreground">
        Each row is a separate category. The count shows matching kept keywords, before URL overrides.
      </p>
    </div>
  );
}
