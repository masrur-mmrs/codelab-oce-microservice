import Docker from "dockerode"

export declare interface ExtendedContainerCreateOptions extends Docker.ContainerCreateOptions {
    Platform?: string;
}