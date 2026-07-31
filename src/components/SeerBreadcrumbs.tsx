import { Fragment } from "react";
import { Link } from "react-router";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";

export interface SeerCrumb {
  /** Display label. */
  label: string;
  /** Optional href — omit for the current page (the trailing crumb). */
  to?: string;
}

interface SeerBreadcrumbsProps {
  items: SeerCrumb[];
  className?: string;
}

/**
 * Shared breadcrumb wrapper for every authenticated page. The last item is
 * rendered as the active page (no link). Earlier items render as router links.
 */
export function SeerBreadcrumbs({ items, className }: SeerBreadcrumbsProps) {
  if (!items.length) return null;
  return (
    <Breadcrumb className={className ?? "px-1"}>
      <BreadcrumbList>
        {items.map((item, idx) => {
          const isLast = idx === items.length - 1;
          return (
            <Fragment key={`${item.label}-${idx}`}>
              <BreadcrumbItem>
                {isLast || !item.to ? (
                  <BreadcrumbPage>{item.label}</BreadcrumbPage>
                ) : (
                  <BreadcrumbLink asChild>
                    <Link to={item.to}>{item.label}</Link>
                  </BreadcrumbLink>
                )}
              </BreadcrumbItem>
              {!isLast && <BreadcrumbSeparator />}
            </Fragment>
          );
        })}
      </BreadcrumbList>
    </Breadcrumb>
  );
}

export default SeerBreadcrumbs;
