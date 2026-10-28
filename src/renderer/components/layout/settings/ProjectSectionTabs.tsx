import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';

import { PROJECT_SECTIONS, type ProjectSection } from './project-settings-sections';

import type { Project } from '@/types';

/** A git project's sections as tabs under its page heading, alongside those in the nav. */
export function ProjectSectionTabs({
  project,
  section,
  onSectionChange,
}: {
  project: Project;
  section: ProjectSection;
  onSectionChange: (section: ProjectSection) => void;
}) {
  return (
    <Tabs value={section} onValueChange={(value) => onSectionChange(value as ProjectSection)}>
      {/* Sits on the header's bottom border, so the active tab's underline replaces it. */}
      <TabsList
        aria-label={`${project.name} sections`}
        className="-mb-px flex h-auto justify-start gap-5 rounded-none bg-transparent p-0"
      >
        {PROJECT_SECTIONS.map(({ value, label, icon: SectionIcon }) => (
          <TabsTrigger
            key={value}
            value={value}
            className="gap-1.5 rounded-none border-b-2 border-transparent px-0.5 pt-0 pb-2.5 text-[13px] text-muted-foreground hover:text-foreground data-[state=active]:border-foreground data-[state=active]:bg-transparent data-[state=active]:shadow-none"
          >
            <SectionIcon className="size-4 shrink-0" />
            {label}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}
