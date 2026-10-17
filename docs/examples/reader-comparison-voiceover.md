# What each screen reader said: site/test-case.html

Recorded 2026-10-17T07:32:25.666Z on darwin 27.0.0, with Guidepup 0.36.3 and Guidepup's virtual screen reader 0.33.0.

| Reader                           | Announcements | Says what VoiceOver says |
| -------------------------------- | ------------: | -----------------------: |
| AEE's virtual screen reader      |            39 |           92% (33 of 36) |
| Guidepup's virtual screen reader |            93 |           92% (33 of 36) |
| VoiceOver                        |            47 |                          |

A VoiceOver phrase counts when a virtual reader has a phrase with every word of it that the page says; each reader's own words ("heading", "level", "end of list", a list position) and the order do not count. A rough measure; the table below is the evidence.

VoiceOver said, and AEE's virtual screen reader did not:

- link test-case.html
- Team plan · 5 seats · renews on 1 March
- To get missing image descriptions, open the context menu. Unlabeled image

VoiceOver said, and Guidepup's virtual screen reader did not:

- link test-case.html
- Team plan · 5 seats · renews on 1 March
- To get missing image descriptions, open the context menu. Unlabeled image

Rows line up by step, not by element: each reader groups a page's content its own way.

| Step | AEE's virtual screen reader                                                      | Guidepup's virtual screen reader                 | VoiceOver                                                                 |
| ---: | -------------------------------------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------- |
|    1 | banner                                                                           | document                                         | banner                                                                    |
|    2 | Open the fixed page, link                                                        | banner                                           | link Open the fixed page                                                  |
|    3 | main                                                                             | link, Open the fixed page                        | end of banner                                                             |
|    4 | Breadcrumb, navigation                                                           | end of banner                                    | main                                                                      |
|    5 | list                                                                             | main                                             | Breadcrumb navigation                                                     |
|    6 | Test lab, listitem                                                               | navigation, Breadcrumb                           | list 2 items                                                              |
|    7 | Test lab, link                                                                   | list                                             | link Test lab 1 of 2                                                      |
|    8 | Workspace overview, listitem                                                     | listitem, level 1, position 1, set size 2        | Workspace overview current page 2 of 2                                    |
|    9 | Practice page · Fictional data · With deliberate accessibility issues, paragraph | link, Test lab                                   | end of list                                                               |
|   10 | Workspace overview, heading, level 1                                             | end of listitem, level 1, position 1, set size 2 | end of Breadcrumb navigation                                              |
|   11 | Manage your projects and workspace preferences., paragraph                       | listitem, level 1, position 2, set size 2        | Practice page · Fictional data ·                                          |
|   12 | Upgrade to Team for unlimited projects, image                                    | current page                                     | With deliberate accessibility issues                                      |
|   13 | Search projects                                                                  | Workspace overview                               | heading level 1 Workspace overview                                        |
|   14 | searchbox                                                                        | end, current page                                | Manage your projects and workspace preferences.                           |
|   15 | Projects, region                                                                 | end of listitem, level 1, position 2, set size 2 | Upgrade to Team for unlimited projects image                              |
|   16 | Projects, heading, level 2                                                       | end of list                                      | Search projects                                                           |
|   17 | Work in this workspace., paragraph                                               | end of navigation, Breadcrumb                    | search text field blank                                                   |
|   18 | link                                                                             | paragraph                                        | Projects region                                                           |
|   19 | article                                                                          | Practice page · Fictional data ·                 | heading level 2 Projects                                                  |
|   20 | Project Alpha                                                                    | strong                                           | Work in this workspace.                                                   |
|   21 | Website accessibility review, paragraph                                          | With deliberate accessibility issues             | link test-case.html                                                       |
|   22 | button                                                                           | end of strong                                    | article                                                                   |
|   23 | Export report                                                                    | end of paragraph                                 | Project Alpha                                                             |
|   24 | Workspace settings, region                                                       | heading, Workspace overview, level 1             | Website accessibility review                                              |
|   25 | Workspace settings, heading, level 3                                             | Workspace overview                               | button                                                                    |
|   26 | Preferences for every project in this workspace., paragraph                      | end of heading, Workspace overview, level 1      | end of article                                                            |
|   27 | Weekly digest                                                                    | paragraph                                        | Export report                                                             |
|   28 | Enabled, paragraph                                                               | Manage your projects and workspace preferences.  | end of Projects region                                                    |
|   29 | Toggle weekly digest, button, pressed                                            | end of paragraph                                 | Workspace settings region                                                 |
|   30 | Plan details, paragraph                                                          | image, Upgrade to Team for unlimited projects    | heading level 3 Workspace settings                                        |
|   31 | Sync settings, button                                                            | form                                             | Preferences for every project in this workspace.                          |
|   32 | heading, level 2                                                                 | Search projects                                  | Weekly digest                                                             |
|   33 | image                                                                            | searchbox                                        | Enabled                                                                   |
|   34 | Usage resets on the first day of each month., paragraph                          | end of form                                      | Toggle weekly digest selected toggle button                               |
|   35 | Plan limits, list                                                                | region, Projects                                 | Plan details                                                              |
|   36 | Seats: 5 of 5, listitem                                                          | heading, Projects, level 2                       | Team plan · 5 seats · renews on 1 March                                   |
|   37 | Storage: 12 of 10 GB, listitem                                                   | paragraph                                        | Sync settings button                                                      |
|   38 | Projects: 3 of 20, listitem                                                      | Work in this workspace.                          | end of Workspace settings region                                          |
|   39 | No changes made., paragraph                                                      | link                                             | To get missing image descriptions, open the context menu. Unlabeled image |
|   40 |                                                                                  | end of paragraph                                 | Usage resets on the first day of each month.                              |
|   41 |                                                                                  | article                                          | list Plan limits 3 items                                                  |
|   42 |                                                                                  | strong                                           | Seats: 5 of 5 1 of 3                                                      |
|   43 |                                                                                  | Project Alpha                                    | Storage: 12 of 10 GB 2 of 3                                               |
|   44 |                                                                                  | end of strong                                    | Projects: 3 of 20 3 of 3                                                  |
|   45 |                                                                                  | paragraph                                        | end of list                                                               |
|   46 |                                                                                  | Website accessibility review                     | No changes made.                                                          |
|   47 |                                                                                  | end of paragraph                                 | end of main                                                               |
|   48 |                                                                                  | button                                           |                                                                           |
|   49 |                                                                                  | end of article                                   |                                                                           |
|   50 |                                                                                  | Export report                                    |                                                                           |
|   51 |                                                                                  | end of region, Projects                          |                                                                           |
|   52 |                                                                                  | region, Workspace settings                       |                                                                           |
|   53 |                                                                                  | heading, Workspace settings, level 3             |                                                                           |
|   54 |                                                                                  | paragraph                                        |                                                                           |
|   55 |                                                                                  | Preferences for every project in this workspace. |                                                                           |
|   56 |                                                                                  | end of paragraph                                 |                                                                           |
|   57 |                                                                                  | strong                                           |                                                                           |
|   58 |                                                                                  | Weekly digest                                    |                                                                           |
|   59 |                                                                                  | end of strong                                    |                                                                           |
|   60 |                                                                                  | paragraph                                        |                                                                           |
|   61 |                                                                                  | Enabled                                          |                                                                           |
|   62 |                                                                                  | end of paragraph                                 |                                                                           |
|   63 |                                                                                  | button, Toggle weekly digest, pressed            |                                                                           |
|   64 |                                                                                  | paragraph                                        |                                                                           |
|   65 |                                                                                  | strong                                           |                                                                           |
|   66 |                                                                                  | Plan details                                     |                                                                           |
|   67 |                                                                                  | end of strong                                    |                                                                           |
|   68 |                                                                                  | end of paragraph                                 |                                                                           |
|   69 |                                                                                  | button, Sync settings                            |                                                                           |
|   70 |                                                                                  | end of region, Workspace settings                |                                                                           |
|   71 |                                                                                  | region                                           |                                                                           |
|   72 |                                                                                  | heading, level 2                                 |                                                                           |
|   73 |                                                                                  | image                                            |                                                                           |
|   74 |                                                                                  | paragraph                                        |                                                                           |
|   75 |                                                                                  | Usage resets on the first day of each month.     |                                                                           |
|   76 |                                                                                  | end of paragraph                                 |                                                                           |
|   77 |                                                                                  | list, Plan limits                                |                                                                           |
|   78 |                                                                                  | listitem, level 1, position 1, set size 3        |                                                                           |
|   79 |                                                                                  | Seats: 5 of 5                                    |                                                                           |
|   80 |                                                                                  | end of listitem, level 1, position 1, set size 3 |                                                                           |
|   81 |                                                                                  | listitem, level 1, position 2, set size 3        |                                                                           |
|   82 |                                                                                  | Storage: 12 of 10 GB                             |                                                                           |
|   83 |                                                                                  | end of listitem, level 1, position 2, set size 3 |                                                                           |
|   84 |                                                                                  | listitem, level 1, position 3, set size 3        |                                                                           |
|   85 |                                                                                  | Projects: 3 of 20                                |                                                                           |
|   86 |                                                                                  | end of listitem, level 1, position 3, set size 3 |                                                                           |
|   87 |                                                                                  | end of list, Plan limits                         |                                                                           |
|   88 |                                                                                  | end of region                                    |                                                                           |
|   89 |                                                                                  | paragraph                                        |                                                                           |
|   90 |                                                                                  | No changes made.                                 |                                                                           |
|   91 |                                                                                  | end of paragraph                                 |                                                                           |
|   92 |                                                                                  | end of main                                      |                                                                           |
|   93 |                                                                                  | end of document                                  |                                                                           |
