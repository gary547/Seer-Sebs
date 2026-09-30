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
  value: string[];
  onChange: (categories: string[]) => void;
  singleSelect?: boolean;
};

type SortOrder = "count" | "name";

function normalise(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

export default function ConversionCategoryPicker({ categories, projectName, value, onChange, singleSelect = false }: Props) {
  const [query, setQuery] = useState("");
  const [sortOrder, setSortOrder] = useState<SortOrder>("count");
  const selectedKeys = useMemo(() => new Set(value.map(normalise)), [value]);

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
  const selectedCategories = categories.filter((category) => selectedKeys.has(normalise(category.category)));
  const selectedKeywordCount = selectedCategories.reduce((total, category) => total + category.keywordCount, 0);
  const visibleSelectedCount = visibleCategories.filter((category) => selectedKeys.has(normalise(category.category))).length;
  const selectedNames = selectedCategories.map((category) => category.category);
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
        {selectedCategories.length > 0 && (
          <span className="rounded-md bg-signal-soft px-2 py-1 text-xs font-medium text-signal-ink">
            {selectedCategories.length.toLocaleString()} selected · {selectedKeywordCount.toLocaleString()} keywords
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
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-hairline px-3 py-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted-foreground">
              {visibleCategories.length.toLocaleString()} shown
            </span>
            {!singleSelect && (
              <>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-7 px-2 text-xs"
                  disabled={visibleCategories.length === 0 || visibleSelectedCount === visibleCategories.length}
                  onClick={() => onChange([
                    ...value,
                    ...visibleCategories
                      .filter((category) => !selectedKeys.has(normalise(category.category)))
                      .map((category) => category.category),
                  ])}
                >
                  Select all in view
                </Button>
                {visibleSelectedCount > 0 && (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="h-7 px-2 text-xs"
                    onClick={() => onChange(value.filter((category) =>
                      !visibleCategories.some((visible) => normalise(visible.category) === normalise(category)),
                    ))}
                  >
                    Clear in view
                  </Button>
                )}
              </>
            )}
          </div>
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
              const isSelected = selectedKeys.has(normalise(category.category));
              return (
                <CommandItem
                  key={category.category}
                  value={category.category}
                  onSelect={() => onChange(singleSelect
                    ? [category.category]
                    : isSelected
                      ? value.filter((selected) => normalise(selected) !== normalise(category.category))
                      : [...value, category.category])}
                  aria-selected={isSelected}
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
      {!singleSelect && selectedNames.length > 0 && (
        <p className="border-t border-hairline bg-signal-soft px-3 py-2 text-xs text-signal-ink" aria-live="polite">
          Selected: {selectedNames.slice(0, 3).join(", ")}
          {selectedNames.length > 3 ? ` + ${selectedNames.length - 3} more` : ""}
        </p>
      )}
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
