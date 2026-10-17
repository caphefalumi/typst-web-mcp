export interface TypstAgent {
  id: string;
  name: string | null;
  avatar?: string | null;
}

export interface TypstProjectAccess {
  canWrite: boolean;
  canReview: boolean;
  canManage: boolean;
}

export interface TypstProjectSummary {
  id: string;
  name: string;
  created?: number | string;
  modified?: number | string;
  owner?: TypstAgent;
  access?: TypstProjectAccess;
  previewed?: string | null;
  pinnedVersion?: string | null;
  folder?: { id: string; name?: string } | null;
}

export interface TypstFileMeta {
  id: string;
  name: string;
  isMultiplayable: boolean;
  lastChange: {
    date: number | string;
  };
  size: number;
  version: number | string;
  magicKind?: string | null;
  etag?: string | null;
}

export interface TypstProjectDetail extends TypstProjectSummary {
  files: TypstFileMeta[];
  shareLinkReadOnly?: string | null;
  shareLinkReviewOnly?: string | null;
  shareLinkReadWrite?: string | null;
  settings?: string | null;
}

export const CORE_AGENT_FIELDS = `
  fragment CoreAgentFields on Agent {
    id
    name
    avatar
  }
`;

export const CORE_FILE_FIELDS = `
  fragment CoreFileFields on File {
    id
    name
    isMultiplayable
    lastChange {
      date
    }
    size
    version
    magicKind
    etag
  }
`;

export const CORE_PROJECT_FIELDS = `
  ${CORE_AGENT_FIELDS}
  fragment CoreProjectFields on Project {
    id
    name
    created
    modified
    owner {
      ...CoreAgentFields
    }
    access {
      canWrite
      canReview
      canManage
    }
    folder {
      id
    }
  }
`;

export const DASHBOARD_CONTENT_QUERY = `
  ${CORE_PROJECT_FIELDS}
  query DashboardContent {
    user {
      id
      name
      email {
        id
        address
        confirmed
      }
      projects {
        ...CoreProjectFields
      }
      externalProjects {
        ...CoreProjectFields
      }
    }
  }
`;

export const PROJECT_FILES_QUERY = `
  ${CORE_AGENT_FIELDS}
  ${CORE_FILE_FIELDS}
  query ProjectFiles($projectId: ID!) {
    project(id: $projectId) {
      id
      name
      modified
      owner {
        ...CoreAgentFields
      }
      shareLinkReadOnly
      shareLinkReviewOnly
      shareLinkReadWrite
      access {
        canReview
        canWrite
        canManage
      }
      previewed
      pinnedVersion
      settings
      files {
        ...CoreFileFields
      }
    }
    user {
      id
      name
      email {
        id
        address
      }
    }
  }
`;

export const FILE_REFRESH_QUERY = `
  ${CORE_FILE_FIELDS}
  query FileRefresh($projectId: ID!, $ids: [ID!]!) {
    project(id: $projectId) {
      files(ids: $ids) {
        ...CoreFileFields
      }
    }
  }
`;

export const CREATE_PROJECT_MUTATION = `
  ${CORE_PROJECT_FIELDS}
  mutation CreateProjectMutation(
    $name: String!
    $owner: ID
    $files: [NewTypstFile!]
    $folder: ID
    $pinnedVersion: String
  ) {
    createProject(
      name: $name
      owner: $owner
      files: $files
      folder: $folder
      pinnedVersion: $pinnedVersion
    ) {
      ...CoreProjectFields
    }
  }
`;

export const EDIT_PROJECT_MUTATION = `
  mutation EditProject(
    $projectId: ID!
    $name: String
    $previewed: ID
    $pinnedVersion: String
  ) {
    updateProject(
      id: $projectId
      name: $name
      previewed: $previewed
      pinnedVersion: $pinnedVersion
    ) {
      id
      name
      previewed
      pinnedVersion
    }
  }
`;

export const DELETE_PROJECT_MUTATION = `
  mutation DeleteProjectMutation($id: ID!) {
    deleteProject(id: $id)
  }
`;

export const UPDATE_FILES_MUTATION = `
  mutation UpdatesFileMutation($projectId: ID!, $updates: [FileUpdate!]!) {
    updateFiles(projectId: $projectId, updates: $updates) {
      id
      name
    }
  }
`;

export const DELETE_FILES_MUTATION = `
  mutation DeleteFilesMutation($projectId: ID!, $ids: [ID!]!) {
    deleteFiles(projectId: $projectId, ids: $ids)
  }
`;
